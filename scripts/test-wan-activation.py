"""Disposable bootstrap CA/issuer, real four-node BFT and HTTPS gateway."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'django-server/sfera_server'))
from release_v1 import canonical
import server_wan_activate as activation
from sfera_mesh.consensus_directory import ConsensusDirectory,rpc
from sfera_mesh.consensus_gateway import GatewaySource
from server_monitor import check


def main():
    binary=Path(sys.argv[1]);root=Path('/opt/sphere-point')
    if root.exists():raise ValueError('disposable_container_only')
    root.mkdir(parents=True,mode=0o700);(root/'code').mkdir();(root/'code/preparing.json').write_bytes(canonical({'version':str(Path(__file__).resolve().parents[1])}));shutil.copy2(binary,root/'code/mesh-verifier')
    activation.bootstrap_seed('127.0.0.1');public=json.loads((root/'seed/bootstrap-public.json').read_bytes());before=(root/'seed/issuer.key').read_bytes();activation.bootstrap_seed('127.0.0.1');assert (root/'seed/issuer.key').read_bytes()==before
    assert 'PRIVATE KEY' not in json.dumps(public) and before.hex() not in json.dumps(public)
    os.environ['SSL_CERT_FILE']=str(root/'seed/ca.pem')
    now=time.monotonic();processes=[];logs=[];seed=None
    with tempfile.TemporaryDirectory(prefix='activation-test-') as temporary:
        folder=Path(temporary);issuers=folder/'issuers.json';key=public['issuer_public_key'];issuers.write_bytes(canonical({hashlib.sha256(bytes.fromhex(key)).hexdigest():key}));home=folder/'consensus'
        subprocess.run([str(binary),'--home',str(home),'--init','--https-endpoints','--placement-policy','--license-issuers',str(issuers)],check=True,stdout=subprocess.DEVNULL)
        lab=json.loads((home/'lab.json').read_bytes());addresses=[a.replace('tcp://','http://') for a in lab['rpc']]
        (root/'genesis.json').write_bytes((home/'0/config/genesis.json').read_bytes())
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        (root/'seed/service.json').write_bytes(canonical({'rpc':addresses[0],'port':port}))
        try:
            for i in range(4):
                log=(folder/f'validator-{i}.log').open('wb');logs.append(log);processes.append(subprocess.Popen([str(binary),'--home',str(home),'--validator',str(i)],stdout=log,stderr=log))
            deadline=time.monotonic()+90
            while True:
                try:
                    if all(int(rpc(a,'status',{})['sync_info']['latest_block_height'])>=2 for a in addresses):break
                except (OSError,ValueError,KeyError):pass
                if time.monotonic()>deadline:raise AssertionError('consensus timeout')
                time.sleep(.3)
            log=(folder/'seed.log').open('wb');logs.append(log);seed=subprocess.Popen([sys.executable,'-B',str(Path(__file__).with_name('server_trial_seed.py'))],stdout=log,stderr=log)
            context=ssl.create_default_context(cafile=str(root/'seed/ca.pem'));deadline=time.monotonic()+45
            while not check('https://127.0.0.1:'+str(port),context=context)['ready']:
                if seed.poll() is not None:raise AssertionError((folder/'seed.log').read_text())
                if time.monotonic()>deadline:raise AssertionError('seed timeout')
                time.sleep(.3)
            os.environ['SSL_CERT_FILE']=str(root/'seed/ca.pem');directory=ConsensusDirectory(str(folder/'observer.sqlite'),str(binary),str(root/'genesis.json'))
            try:directory.refresh(GatewaySource('https://127.0.0.1:'+str(port)))
            finally:directory.close()
            print(json.dumps({'bootstrap_private_keys_stay_local':True,'bootstrap_retry_preserves_keys':True,'real_four_validator_https_gateway':True,'verified_consensus_snapshot':True,'elapsed_seconds':round(time.monotonic()-now,1)}),flush=True)
        finally:
            for child in ([seed] if seed else [])+processes:
                if child.poll() is None:child.terminate()
            for child in ([seed] if seed else [])+processes:child.wait(timeout=40)
            for log in logs:log.close()


if __name__=='__main__':main()
