"""One separately provisioned genesis-authorized assessor, never a quorum keyring."""
from hashlib import sha256
import re
from .capacity import CapacityAssessor,CapacityPolicy
from .directory import digest64
from .failures import FailureObserver
from .storage import canonical


def validate_assessment(policy,peers):
    from pathlib import Path
    fields={'assessor_key','assessor_sha256','bindings','failure_domains','capacity_policy','discovery'}
    if not isinstance(policy,dict) or set(policy)!=fields:raise ValueError('assessment_service_schema')
    if not isinstance(policy['assessor_key'],str) or not Path(policy['assessor_key']).is_absolute() or not digest64(policy['assessor_sha256']) or type(policy['discovery']) is not bool:raise ValueError('assessment_key_pin_and_route_policy_required')
    bindings=policy['bindings'];domains=policy['failure_domains']
    if not isinstance(bindings,dict) or len(bindings)!=4 or any(not digest64(a) or not isinstance(n,str) or n not in peers for a,n in bindings.items()) or len(set(bindings.values()))!=4:raise ValueError('four_distinct_assessment_observers_required')
    if not isinstance(domains,dict) or not 1<=len(domains)<=64 or not set(domains)<=set(peers) or any(not isinstance(d,str) or not re.fullmatch('[a-zA-Z0-9._-]{1,64}',d) for d in domains.values()):raise ValueError('pinned_assessment_inventory_required')
    thresholds=policy['capacity_policy']
    if not isinstance(thresholds,dict) or set(thresholds)!={'bytes_per_slot','transport_bytes_per_second_per_slot','disk_bytes_per_second_per_slot','reserve_bytes'}:raise ValueError('explicit_assessment_thresholds_required')
    CapacityPolicy(**thresholds)
    return policy


def assessment_binding(policy):return sha256(canonical({k:v for k,v in policy.items() if k!='assessor_key'})).hexdigest()


def provision_assessment(policy,directory,key,verifier,peers,health,assessor_key):
    validate_assessment(policy,peers)
    public=assessor_key.public_key().public_bytes_raw();assessor=sha256(public).hexdigest()
    if (directory.endpoint_policy!='https-v1' or set(policy['bindings'])!=set(directory.placement_assessors)
            or directory.placement_assessors.get(assessor)!=public.hex() or policy['bindings'].get(assessor)!=verifier.recipient or health is None):raise ValueError('assessment_identity_must_be_provisioned_in_genesis')
    endpoints={node:peer['endpoint'] for node,peer in peers.items()}
    capacity=CapacityAssessor(directory,assessor_key,key,verifier,endpoints,policy['failure_domains'],CapacityPolicy(**policy['capacity_policy']))
    failure=FailureObserver(assessor_key,health,directory,policy['bindings'])
    return capacity,failure
