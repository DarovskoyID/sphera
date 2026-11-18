"""One bounded HTTPS readiness check and local transition report; no messages sent."""
import argparse
import hashlib
from pathlib import Path
import ssl
import sys
import time
from urllib.error import HTTPError
from urllib.request import build_opener,ProxyHandler,HTTPSHandler,Request
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'django-server/sfera_server'))
from sfera_mesh.public_transport import endpoint_url
from sfera_mesh.transport import NoRedirect
from release_v1 import canonical,parse


def check(endpoint,*,context=None,key=None,network=None):
    endpoint=endpoint_url(endpoint);context=context or ssl.create_default_context()
    if context.verify_mode!=ssl.CERT_REQUIRED or not context.check_hostname:raise ValueError('verified_monitor_tls_required')
    opener=build_opener(ProxyHandler({}),HTTPSHandler(context=context),NoRedirect())
    started=time.monotonic();ready=False
    try:
        with opener.open(Request(endpoint+'/readyz',headers={'Accept':'application/json'}),timeout=5) as response:
            raw=response.read(1025)
            ready=response.status==200 and len(raw)<=1024 and parse(raw,1024)=={'ready':True}
        if ready and key is not None:
            ready=False
            # An IP/port can resolve to another service (NAT, proxy, stale DNS).
            # Bind readiness to this node's signed fresh challenge as well.
            import secrets
            from sfera_mesh.identity import EnvelopeVerifier,node_id
            from sfera_mesh.public_transport import ConfiguredHttpsTransport
            if not isinstance(network,str) or not network:raise ValueError('monitor_network_required')
            public=key.public_key().public_bytes_raw();identity=node_id(public);verifier=EnvelopeVerifier(network,identity,{identity:public},':memory:')
            try:
                nonce=secrets.token_hex(32);result=ConfiguredHttpsTransport({identity:endpoint},context=context).exchange(key,verifier,identity,'probe',{'challenge':nonce})
                ready=result=={'challenge':nonce,'alive':True}
            finally:verifier.close()
    except (OSError,ValueError,HTTPError) as error:
        if hasattr(error,'close'):error.close()
    return {'ready':ready,'elapsed_ms':round((time.monotonic()-started)*1000)}


def transition(previous,endpoint,result,*,failure_threshold=3,recovery_threshold=2,now=None):
    endpoint=endpoint_url(endpoint)
    if type(failure_threshold) is not int or type(recovery_threshold) is not int or not 1<=failure_threshold<=100 or not 1<=recovery_threshold<=100:raise ValueError('monitor_threshold')
    policy=hashlib.sha256(canonical({'endpoint':endpoint,'failure_threshold':failure_threshold,'recovery_threshold':recovery_threshold})).hexdigest()
    if previous is None:previous={'domain':'sphere-readiness-monitor-v1','policy':policy,'status':'unknown','successes':0,'failures':0,'checked_at':0}
    if not isinstance(previous,dict) or set(previous)!={'domain','policy','status','successes','failures','checked_at'} or previous['domain']!='sphere-readiness-monitor-v1' or previous['policy']!=policy or previous['status'] not in ('unknown','up','down'):
        raise ValueError('dedicated_monitor_state_required')
    if any(type(previous[field]) is not int or previous[field]<0 for field in ('successes','failures','checked_at')):raise ValueError('monitor_state_counter')
    ready=result.get('ready') is True
    successes=min(previous['successes']+1,100) if ready else 0;failures=0 if ready else min(previous['failures']+1,100)
    status=previous['status']
    if successes>=recovery_threshold:status='up'
    if failures>=failure_threshold:status='down'
    event=None
    if status!=previous['status'] and status!='unknown':event={'event':'point_ready' if status=='up' else 'point_unavailable','endpoint':endpoint,'previous_status':previous['status']}
    return {'domain':'sphere-readiness-monitor-v1','policy':policy,'status':status,'successes':successes,'failures':failures,'checked_at':int(time.time() if now is None else now)},event


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--endpoint',required=True);parser.add_argument('--state-directory',required=True)
    parser.add_argument('--failure-threshold',type=int,default=3);parser.add_argument('--recovery-threshold',type=int,default=2)
    args=parser.parse_args()
    from server_install import directory
    from server_state import point_lock
    folder=directory(args.state_directory)
    # Dedicated monitor directory only; never open application/replay SQLite.
    with point_lock(folder):
        if any(p.name not in ('point.lock','monitor.json') for p in folder.iterdir()):raise ValueError('dedicated_monitor_directory_required')
        state=folder/'monitor.json'
        if state.is_symlink():raise ValueError('monitor_state_link')
        previous=parse(state.read_bytes()) if state.exists() else None
        result=check(args.endpoint);value,event=transition(previous,args.endpoint,result,failure_threshold=args.failure_threshold,recovery_threshold=args.recovery_threshold)
        import os,tempfile
        descriptor,name=tempfile.mkstemp(prefix='monitor-',dir=folder)
        with os.fdopen(descriptor,'wb') as output:output.write(canonical(value));output.flush();os.fsync(output.fileno())
        os.replace(name,state)
    print(canonical({'status':value['status'],'event':event,**result}).decode())
    return 0 if result['ready'] else 1


if __name__=='__main__':raise SystemExit(main())
