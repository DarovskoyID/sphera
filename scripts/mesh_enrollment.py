"""Explicit publisher-side enrollment role; ordinary points never enable it."""
import hashlib
import os
from pathlib import Path
import sys
from release_v1 import canonical,HEX


def validate_enrollment(policy):
    fields={'issuer_key','issuer_sha256','ca_certificate','ca_sha256','ca_key','ca_key_sha256'}
    if not isinstance(policy,dict) or set(policy)!=fields:raise ValueError('enrollment_service_schema')
    for field in ('issuer_key','ca_certificate','ca_key'):
        if not isinstance(policy[field],str) or not Path(policy[field]).is_absolute():raise ValueError('absolute_enrollment_paths_required')
    for field in ('issuer_sha256','ca_sha256','ca_key_sha256'):
        if not isinstance(policy[field],str) or not HEX.fullmatch(policy[field]):raise ValueError('pinned_enrollment_keys_required')
    return policy


def enrollment_binding(policy):
    validate_enrollment(policy)
    return hashlib.sha256(canonical({k:v for k,v in policy.items() if k.endswith('sha256')})).hexdigest()


def provision_enrollment(policy,directory,path,check_file):
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    from sfera_mesh.identity import load_identity
    from sfera_mesh.point_enrollment import PointEnrollment
    validate_enrollment(policy)
    files={field:check_file(policy[field],policy[pin]) for field,pin in
           (('issuer_key','issuer_sha256'),('ca_certificate','ca_sha256'),('ca_key','ca_key_sha256'))}
    for field in ('issuer_key','ca_key'):
        if sys.platform=='linux' and files[field].stat().st_mode&0o077:raise ValueError('enrollment_key_requires_private_permissions')
    # Public scope is fixed here: no production configuration can issue
    # certificates for loopback/private observed addresses.
    return PointEnrollment(path,directory,load_identity(files['issuer_key']),
        x509.load_pem_x509_certificate(files['ca_certificate'].read_bytes()),
        serialization.load_pem_private_key(files['ca_key'].read_bytes(),password=None),endpoint_scope='public')
