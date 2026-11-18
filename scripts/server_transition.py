"""Publisher-signed compatibility contract, bound to both releases and environments."""
import argparse
from pathlib import Path
import time
from release_v1 import canonical,parse,document,certificate,sign,fields,integer
from server_schema import snapshot,projected,digest


def binding(active):
    return {name:active[name] for name in ('sequence','manifest_sha256','runtime','environment_sha256')}


def portable_binding(active):
    return {**{name:active[name] for name in ('sequence','manifest_sha256','runtime')},'wheel_lock_sha256':active['deployment']['lock_sha256']}


def validate(bundle,trust,old,new,before):
    now=int(time.time());body=document(bundle,trust['root_public_key'],trust['channel'],'release')
    if body.get('domain')=='sphere-server-transition-preserve-v1':
        fields(body,'domain product channel issued_at expires_at from_release to_release allowed_schemas compatibility')
        cert=certificate(bundle['certificate'],trust['root_public_key'],trust['channel'],'release')
        integer(body['issued_at'],1,2**53-1);integer(body['expires_at'],1,2**53-1)
        schemas=body['allowed_schemas']
        if (body['product']!='sphere' or body['channel']!=trust['channel'] or body['compatibility']!='sqlite-preserve-backward-v1'
                or not now-86400<=body['issued_at']<=now+5 or not now<body['expires_at']<=min(body['issued_at']+86400,cert['expires_at'])
                or body['from_release']!=portable_binding(old) or body['to_release']!=portable_binding(new)
                or not isinstance(schemas,list) or not 1<=len(schemas)<=8 or any(not isinstance(h,str) or len(h)!=64 or any(c not in '0123456789abcdef' for c in h) for h in schemas)
                or digest(before) not in schemas):raise ValueError('portable_transition_binding_or_schema')
        if (old['environment_sha256']!=new['environment_sha256'] or any(old['deployment'][k]!=new['deployment'][k] for k in ('environment','lock_sha256'))):raise ValueError('portable_update_requires_unchanged_environment')
        return [],before
    fields(body,'domain product channel issued_at expires_at from_release to_release before_schema_sha256 after_schema_sha256 operations compatibility')
    cert=certificate(bundle['certificate'],trust['root_public_key'],trust['channel'],'release')
    integer(body['issued_at'],1,2**53-1);integer(body['expires_at'],1,2**53-1)
    if (body['domain']!='sphere-server-transition-v1' or body['product']!='sphere' or body['channel']!=trust['channel']
            or body['compatibility']!='sqlite-additive-backward-v1' or not now-86400<=body['issued_at']<=now+5
            or not now<body['expires_at']<=min(body['issued_at']+86400,cert['expires_at'])
            or body['from_release']!=binding(old) or body['to_release']!=binding(new)
            or body['before_schema_sha256']!=digest(before)):
        raise ValueError('release_transition_binding_or_expiry')
    after=projected(before,body['operations'])
    if digest(after)!=body['after_schema_sha256']:raise ValueError('release_transition_projected_schema')
    return body['operations'],after


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('private','certificate','trust','from-record','to-record','stopped-state','operations','output'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--preserve',action='store_true',help='Portable state-preserving update for an explicitly approved reference schema; environment stays unchanged')
    args=parser.parse_args()
    from release_keys import load_key
    from release_v1 import public_text
    from server_state import point_lock
    trust=parse(Path(args.trust).read_bytes());cert=parse(Path(args.certificate).read_bytes());key=load_key(args.private)
    checked=certificate(cert,trust['root_public_key'],trust['channel'],'release')
    if public_text(key.public_key())!=checked['public_key']:raise ValueError('transition_signer_mismatch')
    old=parse(Path(args.from_record).read_bytes());new=parse(Path(args.to_record).read_bytes());operations=parse(Path(args.operations).read_bytes())
    with point_lock(Path(args.stopped_state)):
        before=snapshot(Path(args.stopped_state));after=projected(before,operations)
    now=int(time.time());body={'domain':'sphere-server-transition-v1','product':'sphere','channel':trust['channel'],
        'issued_at':now,'expires_at':min(now+86400,checked['expires_at']),'from_release':binding(old),'to_release':binding(new),
        'before_schema_sha256':digest(before),'after_schema_sha256':digest(after),'operations':operations,'compatibility':'sqlite-additive-backward-v1'}
    if args.preserve:
        if operations:raise ValueError('portable_update_cannot_migrate_schema')
        body={'domain':'sphere-server-transition-preserve-v1','product':'sphere','channel':trust['channel'],'issued_at':now,'expires_at':min(now+86400,checked['expires_at']),
            'from_release':portable_binding(old),'to_release':portable_binding(new),'allowed_schemas':[digest(before)],'compatibility':'sqlite-preserve-backward-v1'}
    bundle={'certificate':cert,'document':sign(body,key)};validate(bundle,trust,old,new,before)
    with Path(args.output).open('xb') as output:output.write(canonical(bundle))


if __name__=='__main__':main()
