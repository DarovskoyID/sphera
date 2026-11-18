"""Bounded consensus-committed ciphertext index, certified by a storage majority."""
from hashlib import sha256
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .directory import digest64, ZERO
from .identity import node_id
from .storage import canonical


def manifest_body(network, placement, digests, *, version=1, previous=ZERO, sizes=None):
    body={'domain':'sfera-mesh-manifest-v1','network':network,'cluster':placement['record']['body']['cluster'],'epoch':placement['record']['body']['epoch'],'placement_hash':placement['digest'],'version':version,'previous':previous,'digests':sorted(digests)}
    if sizes is not None:
        if not isinstance(sizes,dict) or set(sizes)!=set(body['digests']): raise ValueError('invalid_manifest_sizes')
        body.update(domain='sfera-mesh-manifest-v2',sizes=[sizes[digest] for digest in body['digests']])
    validate_manifest_body(body,network,placement)
    return body


def manifest_record(network, placement, digests, keys, *, version=1, previous=ZERO, sizes=None):
    body=manifest_body(network,placement,digests,version=version,previous=previous,sizes=sizes)
    consents=[{'public_key':key.public_key().public_bytes_raw().hex(),'signature':key.sign(canonical(body)).hex()} for key in keys]
    record={'body':body,'consents':sorted(consents,key=lambda consent:consent['public_key'])}
    validate_manifest(record,network,placement)
    return record


def validate_manifest_body(body,network,placement):
    fields={'domain','network','cluster','epoch','placement_hash','version','previous','digests'}
    if isinstance(body,dict) and body.get('domain')=='sfera-mesh-manifest-v2': fields.add('sizes')
    if not isinstance(body,dict) or set(body)!=fields or body['domain'] not in ('sfera-mesh-manifest-v1','sfera-mesh-manifest-v2') or body['network']!=network or body['cluster']!=placement['record']['body']['cluster'] or type(body['epoch']) is not int or body['epoch']!=placement['record']['body']['epoch'] or body['placement_hash']!=placement['digest'] or type(body['version']) is not int or not 1<=body['version']<=2**63-1 or not digest64(body['previous']) or (body['version']==1 and body['previous']!=ZERO):
        raise ValueError('invalid_manifest_context')
    digests=body['digests']
    if not isinstance(digests,list) or len(digests)>512 or any(not digest64(value) for value in digests) or sorted(set(digests))!=digests:
        raise ValueError('invalid_manifest_digests')
    if body['domain']=='sfera-mesh-manifest-v2' and (not isinstance(body['sizes'],list) or len(body['sizes'])!=len(digests) or any(type(size) is not int or not 1<=size<=262144 for size in body['sizes'])):
        raise ValueError('invalid_manifest_sizes')
    return body


def validate_manifest(record,network,placement):
    if not isinstance(record,dict) or set(record)!={'body','consents'} or len(canonical(record))>65536:
        raise ValueError('invalid_manifest_record')
    body=validate_manifest_body(record['body'],network,placement)
    consents=record['consents']
    if not isinstance(consents,list) or len(consents)!=2:
        raise ValueError('storage_majority_required')
    prior=''
    for consent in consents:
        if not isinstance(consent,dict) or set(consent)!={'public_key','signature'} or not digest64(consent['public_key']) or consent['public_key']<=prior:
            raise ValueError('distinct_sorted_manifest_signers_required')
        try:
            public=bytes.fromhex(consent['public_key']); signature=bytes.fromhex(consent['signature'])
            if node_id(public) not in placement['record']['body']['members'] or len(signature)!=64 or signature.hex()!=consent['signature']:
                raise ValueError('manifest_signer_identity')
            Ed25519PublicKey.from_public_bytes(public).verify(signature,canonical(body))
        except (ValueError,TypeError,InvalidSignature) as exc:
            raise ValueError('invalid_manifest_signature') from exc
        prior=consent['public_key']
    return body,sha256(canonical(record)).hexdigest()


def validate_manifests(state,network):
    from .manifest_ancestry import validate_lineages
    validate_lineages(state,network)
    manifests=state.get('manifests',{})
    if not isinstance(manifests,dict): raise ValueError('invalid_manifest_registry')
    for cluster,head in manifests.items():
        if not isinstance(head,dict) or set(head)!={'record','digest'}:
            raise ValueError('invalid_manifest_head')
        epoch=head.get('record',{}).get('body',{}).get('epoch')
        history=state.get('placement_history',{}).get(cluster,[])
        if type(epoch) is not int or not 1<=epoch<=len(history): raise ValueError('manifest_placement_history_required')
        body,digest=validate_manifest(head['record'],network,history[epoch-1])
        if body['cluster']!=cluster or digest!=head['digest']: raise ValueError('invalid_manifest_head')
