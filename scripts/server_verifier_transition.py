"""Root-authorized, stopped-point verifier handoff, preserving all point data.

This is deliberately separate from ordinary source updates: changing the
verifier changes protected operator inputs and needs its own exact signed
contract. Never edit the old executable or reset the admission/release floor.
"""
import argparse
import hashlib
import os
from pathlib import Path
import tempfile
import time
from release_v1 import canonical,document,certificate
from server_update import read_json,input_binding,Supervisor
from server_state import point_lock


def sha(path):
    with Path(path).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def contract(packet,trust,*,now=None):
    body=document(packet,trust['root_public_key'],trust['channel'],'release')
    cert=certificate(packet['certificate'],trust['root_public_key'],trust['channel'],'release')
    fields={'domain','product','channel','issued_at','expires_at','network','genesis','from_verifier','to_verifier','release_sequence'}
    now=int(time.time()) if now is None else now
    if (set(body)!=fields or body['domain']!='sphere-point-verifier-transition-v1' or body['product']!='sphere'
            or body['channel']!=trust['channel'] or type(body['issued_at']) is not int or type(body['expires_at']) is not int
            or not now-86400<=body['issued_at']<=now+5 or not now<body['expires_at']<=min(body['issued_at']+86400,cert['expires_at'])
            or type(body['release_sequence']) is not int or body['release_sequence']<trust['minimum_sequence']
            or not isinstance(body['network'],str) or not body['network']):
        raise ValueError('verifier_transition_context')
    for name in ('genesis','from_verifier','to_verifier'):
        value=body[name]
        if not isinstance(value,str) or len(value)!=64 or any(c not in '0123456789abcdef' for c in value):
            raise ValueError('verifier_transition_digest')
    if body['from_verifier']==body['to_verifier']:raise ValueError('verifier_transition_must_change_binary')
    return body


def replace_private(path,raw,owner):
    path=Path(path)
    if path.is_symlink():raise ValueError('verifier_transition_link')
    fd,name=tempfile.mkstemp(prefix='verifier-handoff-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
        os.chmod(name,0o600);os.chown(name,owner.st_uid,owner.st_gid);os.replace(name,path)
        fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
    finally:
        if os.path.exists(name):os.unlink(name)


def migrate(config,operations,trust,packet,new_binary,receipts):
    if os.geteuid()!=0:raise ValueError('root_stopped_point_handoff_required')
    body=contract(packet,trust);config=Path(config);operations=Path(operations);new_binary=Path(new_binary)
    receipts=Path(receipts)
    if (not receipts.is_absolute() or any(p.is_symlink() for p in (receipts,*receipts.parents))
            or not receipts.is_dir() or receipts.stat().st_uid!=0 or receipts.stat().st_mode&0o077):
        raise ValueError('private_root_handoff_receipts_required')
    # Each verifier has a new immutable, content-addressed path. The admitted
    # previous program and all identity/database files remain untouched.
    if (not new_binary.is_absolute() or any(p.is_symlink() for p in (new_binary,*new_binary.parents))
            or not new_binary.is_file() or new_binary.stat().st_uid!=0 or new_binary.stat().st_mode&0o022
            or new_binary.parent.name!=body['to_verifier'] or sha(new_binary)!=body['to_verifier']):
        raise ValueError('immutable_signed_verifier_required')
    receipt=receipts/(hashlib.sha256(canonical(packet)).hexdigest()+'.json')
    journal_path=operations/'update.json';config_owner=config.stat();journal_owner=journal_path.stat()
    if config.is_symlink() or journal_path.is_symlink():raise ValueError('verifier_transition_link')
    # Acquire the supervisor lock before reading its journal, then the runtime
    # state lock. A running supervisor OR runtime makes this operation fail.
    with point_lock(operations):
        if receipt.exists():
            saved=read_json(receipt)
            if saved.get('contract')!=packet:raise ValueError('verifier_transition_receipt_conflict')
            old_config=bytes.fromhex(saved['old_config']);old_journal=bytes.fromhex(saved['old_journal'])
            new_config=bytes.fromhex(saved['new_config']);new_journal=bytes.fromhex(saved['new_journal'])
            if config.read_bytes() not in (old_config,new_config) or journal_path.read_bytes() not in (old_journal,new_journal):
                raise ValueError('verifier_transition_interrupted_inputs_changed')
            state=read_json_bytes(old_config)['state_directory']
        else:
            old_config=config.read_bytes();old_journal=journal_path.read_bytes();value=read_json_bytes(old_config)
            journal=read_json_bytes(old_journal)
            if (value['network']!=body['network'] or value['genesis_sha256']!=body['genesis']
                    or value['verifier_sha256']!=body['from_verifier'] or sha(value['verifier_binary'])!=body['from_verifier']
                    or journal.get('domain')!='sphere-point-update-v1' or journal.get('phase')!='running'
                    or journal['active']['sequence']!=body['release_sequence'] or journal['floor']<body['release_sequence']
                    or not journal.get('initialized') or (operations/'request.json').exists() or (operations/'processing.json').exists()):
                raise ValueError('verifier_transition_admission_context')
            old_binding,_=input_binding(config)
            policy=hashlib.sha256(canonical({'trust':trust,'config_binding':old_binding})).hexdigest()
            if journal['policy']!=policy:raise ValueError('verifier_transition_old_policy_mismatch')
            supervisor=Supervisor(operations,trust,config,trust['minimum_sequence'])
            admitted,_,_=supervisor.admitted(journal['active']['deployment'],accepted_at=journal['active']['accepted_at'],minimum=journal['active']['sequence'])
            if admitted!=journal['active']:raise ValueError('verifier_transition_installed_source_changed')
            state=value['state_directory']
            new_value={**value,'verifier_binary':str(new_binary),'verifier_sha256':body['to_verifier']}
            new_config=canonical(new_value)
            # Compute the exact new input binding with the same verifier used
            # by the supervisor, through a private temporary configuration.
            fd,path=tempfile.mkstemp(prefix='verifier-config-',dir=config.parent)
            try:
                with os.fdopen(fd,'wb') as stream:stream.write(new_config)
                new_binding,_=input_binding(path)
            finally:os.unlink(path)
            updated={**journal,'policy':hashlib.sha256(canonical({'trust':trust,'config_binding':new_binding})).hexdigest()}
            new_journal=canonical(updated)
        with point_lock(Path(state)):
            if not receipt.exists():
                saved={'contract':packet,'old_config':old_config.hex(),'old_journal':old_journal.hex(),
                       'new_config':new_config.hex(),'new_journal':new_journal.hex()}
                replace_private(receipt,canonical(saved),receipts.stat())
            # A crash between these writes is resumable using only this exact
            # root-owned, signed-contract receipt. No downgrade/data restore.
            replace_private(config,new_config,config_owner)
            replace_private(journal_path,new_journal,journal_owner)
            binding,_=input_binding(config)
            if read_json(journal_path)['policy']!=hashlib.sha256(canonical({'trust':trust,'config_binding':binding})).hexdigest():
                raise ValueError('verifier_transition_new_policy_mismatch')
    return {'verifier_updated':True,'point_data_changed':False,'release_floor':read_json(journal_path)['floor'],
            'from_verifier':body['from_verifier'],'to_verifier':body['to_verifier']}


def read_json_bytes(raw):
    from release_v1 import parse
    return parse(raw,1048576)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('config','operations','trust','transition','new-binary','receipts'):parser.add_argument('--'+name,required=True)
    args=parser.parse_args()
    print(canonical(migrate(args.config,args.operations,read_json(args.trust),read_json(args.transition),args.new_binary,args.receipts)).decode())


if __name__=='__main__':main()
