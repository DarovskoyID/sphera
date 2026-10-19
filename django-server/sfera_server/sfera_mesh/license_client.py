"""Node operator bridge to the fixed commercial issuer. No user content sent."""
import json
import re
import time
from urllib.request import Request, build_opener
from sfera_modules.commercial import config, NoRedirect, CommercialError
from .licenses import verify_attestation
from .identity import node_id
from .storage import canonical


def request_attestation(key, network, trusted_issuers):
    if not isinstance(network, str) or not re.fullmatch('[a-zA-Z0-9._-]{1,128}', network):
        raise ValueError('invalid_mesh_network')
    base, instance, token = config()
    public = key.public_key().public_bytes_raw()
    record = {'domain': 'sfera-mesh-license-binding-v1', 'instance_id': instance, 'public_key': public.hex(), 'network': network, 'timestamp': int(time.time())}
    data = {name: value for name, value in record.items() if name != 'domain'}
    data['proof'] = key.sign(canonical(record)).hex()
    request = Request(base + '/v1/mesh/attestation', data=canonical(data), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json'}, method='POST')
    try:
        with build_opener(NoRedirect()).open(request, timeout=8) as response:
            if response.headers.get_content_type() != 'application/json':
                raise ValueError('invalid_issuer_response')
            body = response.read(16385)
        if len(body) > 16384:
            raise ValueError('issuer_response_too_large')
        document = json.loads(body)
        verified = verify_attestation(document, trusted_issuers, node_id(public), network, instance_id=instance)
        return document, verified
    except (OSError, ValueError, TypeError) as exc:
        raise CommercialError('mesh_attestation_unavailable', 503) from exc
