"""Read-only seven-operator WAN probe. Never creates/admit nodes or claims a launch.

Operator independence is a supplied claim requiring an external audit. A probe
alone cannot certify recovery, WAN partitions, load, governance or backup.
"""
import argparse
import ipaddress
import secrets
import socket
import sys
import time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'django-server'/'sfera_server'))
from sfera_mesh.identity import node_id,load_identity,EnvelopeVerifier
from sfera_mesh.public_transport import endpoint_url,ConfiguredHttpsTransport
from urllib.parse import urlsplit
from release_v1 import parse,canonical


def identity(value):
    if not isinstance(value,dict) or set(value)!={'node_id','public_key'}:raise ValueError('wan_node_identity_schema')
    public=bytes.fromhex(value['public_key'])
    if len(public)!=32 or value['node_id']!=node_id(public):raise ValueError('wan_node_identity_mismatch')
    return value['node_id'],public


def inventory(value):
    if not isinstance(value,dict) or set(value)!={'domain','network','prober','operators'} or value['domain']!='sphere-wan-inventory-v1':raise ValueError('wan_inventory_schema')
    if not isinstance(value['network'],str) or not 1<=len(value['network'])<=128:raise ValueError('wan_network_required')
    probe,public=identity(value['prober']);roster={probe:public}
    if not isinstance(value['operators'],list) or len(value['operators'])!=7:raise ValueError('seven_real_operators_required')
    seen={key:set() for key in ('node_id','endpoint','operator_id','failure_domain')}
    for item in value['operators']:
        if not isinstance(item,dict) or set(item)!={'node_id','public_key','endpoint','operator_id','failure_domain','independence_evidence'}:raise ValueError('wan_operator_schema')
        peer,key=identity({name:item[name] for name in ('node_id','public_key')});endpoint_url(item['endpoint'])
        for field in seen:
            text=item[field]
            if not isinstance(text,str) or not 1<=len(text)<=2048 or text in seen[field] or any(ord(c)<32 for c in text):raise ValueError('wan_duplicate_or_invalid_operator')
            seen[field].add(text)
        if not isinstance(item['independence_evidence'],str) or not 1<=len(item['independence_evidence'])<=2048:raise ValueError('wan_independence_evidence_required')
        if peer==probe:raise ValueError('prober_must_be_separate_identity')
        roster[peer]=key
    return roster


def resolve_public(operators):
    seen=set();result={}
    for item in operators:
        parsed=urlsplit(item['endpoint'])
        addresses={entry[4][0] for entry in socket.getaddrinfo(parsed.hostname,parsed.port or 443,type=socket.SOCK_STREAM)}
        if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):raise ValueError('wan_public_addresses_required')
        normalized={str(ipaddress.ip_address(address)) for address in addresses}
        if normalized & seen:raise ValueError('wan_shared_public_address')
        seen|=normalized;result[item['node_id']]=sorted(normalized)
    return result


def probe(value,key_path,state):
    roster=inventory(value);addresses=resolve_public(value['operators']);key=load_identity(key_path)
    if node_id(key.public_key().public_bytes_raw())!=value['prober']['node_id']:raise ValueError('wan_probe_identity_mismatch')
    verifier=EnvelopeVerifier(value['network'],value['prober']['node_id'],roster,str(state))
    transport=ConfiguredHttpsTransport({item['node_id']:item['endpoint'] for item in value['operators']})
    results=[]
    try:
        for item in value['operators']:
            start=time.monotonic();success=False
            try:
                challenge=secrets.token_hex(32)
                response=transport.exchange(key,verifier,item['node_id'],'probe',{'challenge':challenge})
                success=response=={'challenge':challenge,'alive':True}
            except Exception:pass
            results.append({'node_id':item['node_id'],'tls_and_signed_probe':success,'elapsed_ms':round((time.monotonic()-start)*1000),'resolved_addresses':addresses[item['node_id']]})
    finally:verifier.close()
    return {'domain':'sphere-wan-probe-report-v1','network':value['network'],'checked_at':int(time.time()),'results':results,
        'seven_probes_passed':len(results)==7 and all(item['tls_and_signed_probe'] for item in results),
        'operator_independence_externally_verified':False,'partitions_recovery_load_tested':False,'production_launch_completed':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('inventory','identity','replay-state','output'):parser.add_argument('--'+name,required=True)
    args=parser.parse_args();destination=Path(args.output)
    if not destination.is_absolute() or destination.exists() or destination.is_symlink():raise ValueError('new_wan_report_required')
    value=parse(Path(args.inventory).read_bytes());result=probe(value,args.identity,args.replay_state)
    with destination.open('xb') as output:output.write(canonical(result));output.flush()
    print('Seven signed WAN probes passed.' if result['seven_probes_passed'] else 'WAN probes incomplete; production launch remains open.')
    return 0 if result['seven_probes_passed'] else 1


if __name__=='__main__':raise SystemExit(main())
