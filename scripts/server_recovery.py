"""Release a restored ordinary point only with fresh independent authorization.

Never activates a restored CometBFT signer. The authorized recovery guardian
must independently confirm current protocol checkpoints and fence the old node.
"""
import argparse
import hashlib
import os
from pathlib import Path
import time
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from release_v1 import canonical,parse
from server_backup import digest
from server_state import point_lock
from server_external_backup import collect_tree


def state_digest(state):
    records={}
    ignored={'point.lock','status.json','RESTORE_REQUIRES_CHECKPOINT_VALIDATION.json','RECOVERY_AUTHORIZED.json'}
    for name,path in collect_tree(state,'state').items():
        if path.name in ignored:continue
        records[name]={'size':path.stat().st_size,'sha256':digest(path)}
    return hashlib.sha256(canonical(records)).hexdigest()


def checked_authorization(packet,trusted_public,now):
    if not isinstance(packet,dict) or set(packet)!={'body','signature'}:raise ValueError('recovery_authorization_packet')
    body=packet['body']
    if not isinstance(body,dict) or set(body)!={'domain','network','node','backup_sha256','state_sha256','minimum_release_sequence','not_before','expires_at','source_fenced','activation'}:raise ValueError('recovery_authorization_schema')
    if type(body['minimum_release_sequence']) is not int or body['minimum_release_sequence']<1:raise ValueError('independent_recovery_release_floor_required')
    if body['domain']!='sphere-recovery-authorization-v1' or body['activation']!='ordinary-point-only' or body['source_fenced'] is not True:raise ValueError('independent_checkpoint_and_fencing_required')
    if type(body['not_before']) is not int or type(body['expires_at']) is not int or not body['not_before']<=now<body['expires_at']<=body['not_before']+300:raise ValueError('fresh_recovery_authorization_required')
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(trusted_public)).verify(bytes.fromhex(packet['signature']),canonical(body))
    return body


def verify_adoption(config,trusted_public,*,now=None):
    now=int(time.time() if now is None else now);state=Path(config['state_directory'])
    receipt=state/'RECOVERY_AUTHORIZED.json'
    if receipt.is_symlink():raise ValueError('recovery_receipt_link')
    body=checked_authorization(parse(receipt.read_bytes()),trusted_public,now)
    if not config.get('point_registration') or any(config.get(role) for role in ('serve_consensus','enrollment_service','assessment_service','controllers')):raise ValueError('automatic_recovery_ordinary_point_only')
    from sfera_mesh.identity import load_identity,node_id
    identity=node_id(load_identity(config['node_key']).public_key().public_bytes_raw())
    if body['network']!=config['network'] or body['node']!=identity:raise ValueError('recovery_identity_context')
    if (state/'RESTORE_REQUIRES_CHECKPOINT_VALIDATION.json').exists() or state_digest(state)!=body['state_sha256']:raise ValueError('recovery_checkpoint_state_changed')
    return body


def authorize(recovery,packet,trusted_public,*,now=None):
    root=Path(recovery);now=int(time.time() if now is None else now)
    guard_path=root/'RESTORE_REQUIRES_INDEPENDENT_CHECKPOINT.json'
    if guard_path.is_symlink():raise ValueError('recovery_guard_link')
    guard=parse(guard_path.read_bytes());point=root/'point';config=parse((point/'point.relocated.json').read_bytes())
    body=checked_authorization(packet,trusted_public,now)
    if guard.get('backup_sha256')!=body['backup_sha256'] or guard.get('domain')!='sphere-disaster-restore-guard-v1':raise ValueError('recovery_backup_context')
    if not config.get('point_registration') or config.get('serve_consensus') or config.get('enrollment_service') or config.get('assessment_service') or config.get('controllers'):raise ValueError('automatic_recovery_ordinary_point_only')
    from sfera_mesh.identity import load_identity,node_id
    identity=node_id(load_identity(config['node_key']).public_key().public_bytes_raw())
    if body['network']!=config['network'] or body['node']!=identity:raise ValueError('recovery_identity_context')
    state=Path(config['state_directory'])
    if state.resolve()!= (point/'state').resolve():raise ValueError('isolated_recovery_state_required')
    with point_lock(state):
        if state_digest(state)!=body['state_sha256']:raise ValueError('recovery_checkpoint_state_changed')
        local=state/'RESTORE_REQUIRES_CHECKPOINT_VALIDATION.json';outer=point/'REQUIRES_INDEPENDENT_CHECKPOINT_VALIDATION.json'
        for path in (local,outer):
            if path.is_symlink() or not path.is_file():raise ValueError('complete_recovery_guards_required')
        # Retain the authorization itself as durable evidence. No service is
        # started here; normal verified supervisor admission remains required.
        receipt=state/'RECOVERY_AUTHORIZED.json'
        with receipt.open('xb') as output:output.write(canonical(packet));output.flush();os.fsync(output.fileno())
        local.unlink();outer.unlink()
        for folder in (state,point):
            fd=os.open(folder,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(fd)
            finally:os.close(fd)
    return {'ordinary_point_checkpoint_authorized':True,'validator_signing_enabled':False,'services_started':False}


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--recovery',required=True);p.add_argument('--authorization',required=True);p.add_argument('--trusted-public-key',required=True);a=p.parse_args()
    print(canonical(authorize(a.recovery,parse(Path(a.authorization).read_bytes()),a.trusted_public_key)).decode())


if __name__=='__main__':main()
