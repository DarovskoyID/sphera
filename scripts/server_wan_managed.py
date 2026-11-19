"""Same-owner WAN assessment provisioning; all private keys stay on their host.

The trial genesis authorizes the four validator public keys as assessors.
Each separate assessment daemon reads its own existing signer file locally;
it never copies that file or exposes a general signing endpoint.
"""
import base64
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import signal
import ssl
import subprocess
import sys
import threading
import time

ROOT=Path('/opt/sphere-point')


def validator_identity(path, authorized):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    path=Path(path)
    if path.is_symlink() or path.stat().st_mode&0o077:raise ValueError('private_local_validator_file_required')
    value=json.loads(path.read_bytes())
    if value['priv_key']['type']!='tendermint/PrivKeyEd25519':raise ValueError('ed25519_validator_required')
    raw=base64.b64decode(value['priv_key']['value'],validate=True)
    if len(raw)!=64:raise ValueError('validator_key_size')
    key=Ed25519PrivateKey.from_private_bytes(raw[:32]);public=key.public_key().public_bytes_raw()
    if raw[32:]!=public or base64.b64decode(value['pub_key']['value'],validate=True)!=public or authorized.get(hashlib.sha256(public).hexdigest())!=public.hex():raise ValueError('genesis_local_assessor_required')
    return key


def prepare(job, config, receipt, folder):
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    from sfera_mesh.identity import create_identity,load_identity,node_id
    from sfera_mesh.consensus_directory import ConsensusDirectory
    from sfera_mesh.consensus_gateway import GatewaySource
    from sfera_mesh.point_join import credential,publish,write_private
    target=ROOT/'trial-assessment';target.mkdir(mode=0o700,exist_ok=True)
    key=load_identity(target/'node.key') if (target/'node.key').exists() else create_identity(target/'node.key')
    directory=ConsensusDirectory(str(target/'enroll.sqlite'),config['verifier_binary'],config['genesis'])
    source=GatewaySource(config['consensus_gateways'][0]);context=ssl.create_default_context(cafile=config['point_registration']['ca_certificate'])
    try:
        assessor=validator_identity(ROOT/'consensus/config/priv_validator_key.json',directory.placement_assessors)
        directory.refresh(source)
        body=credential(key,directory,str(source),9444,x509.load_pem_x509_certificate(Path(config['point_registration']['ca_certificate']).read_bytes()),context=context)
        publish(key,directory,source,body)
    finally:directory.close()
    write_private(target/'tls.key',key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()));write_private(target/'tls.pem',body['certificate'].encode())
    public=assessor.public_key().public_bytes_raw();result={'host':receipt['host'],'node_id':node_id(key.public_key().public_bytes_raw()),'public_key':key.public_key().public_bytes_raw().hex(),'assessor':hashlib.sha256(public).hexdigest(),'endpoint':body['endpoint'],'validator_private_key_exported':False,'validator_signing_state_reset':False,'passed':True}
    write_private(target/'public.json',json.dumps(result).encode())
    # Daemon code comes from the publisher-signed job archive, not an SSH upload.
    import zipfile
    with zipfile.ZipFile(sys.argv[0]) as archive:write_private(target/'daemon.py',archive.read('server_wan_managed.py'))
    write_private(target/'job.json',json.dumps(job).encode())
    python=ROOT/'code/environment/venv/bin/python'
    unit='[Unit]\nDescription=Sphere same-owner WAN resource assessor\nAfter=network-online.target\n[Service]\nUser=root\nExecStart='+str(python)+' -B '+str(target/'daemon.py')+'\nRestart=on-failure\nRestartSec=5\nUMask=0077\nNoNewPrivileges=true\nStandardOutput=append:'+str(target/'daemon.log')+'\nStandardError=append:'+str(target/'daemon.log')+'\n[Install]\nWantedBy=multi-user.target\n'
    path=Path('/etc/systemd/system/sphere-trial-assessment.service')
    if path.exists() and path.read_text()!=unit:raise ValueError('existing_assessment_service_preserved')
    write_private(path,unit.encode());subprocess.run(['systemctl','daemon-reload'],check=True,timeout=30);subprocess.run(['systemctl','enable','--now',path.name],check=True,timeout=30)
    if subprocess.run(['which','ufw'],capture_output=True).returncode==0 and 'Status: active' in subprocess.run(['ufw','status'],capture_output=True,text=True).stdout:subprocess.run(['ufw','allow','9444/tcp'],check=True,timeout=30)
    return result


def daemon():
    from sfera_mesh.identity import load_identity,node_id,EnvelopeVerifier
    from sfera_mesh.consensus_directory import ConsensusDirectory
    from sfera_mesh.consensus_gateway import GatewaySource
    from sfera_mesh.consensus_updater import ConsensusUpdater
    from sfera_mesh.point_join import PointRegistration
    from sfera_mesh.capacity import CapacityAssessor,CapacityPolicy
    from sfera_mesh.public_transport import TLSMeshServer,ConfiguredHttpsTransport
    from sfera_mesh.transport import BlobStore
    target=ROOT/'trial-assessment';config=json.loads((ROOT/'data/point.json').read_bytes());job=json.loads((target/'job.json').read_bytes());key=load_identity(target/'node.key');own=node_id(key.public_key().public_bytes_raw())
    os.environ['SSL_CERT_FILE']=config['point_registration']['ca_certificate'];context=ssl.create_default_context(cafile=os.environ['SSL_CERT_FILE'])
    peers={p['node_id']:'https://'+p['host']+':8443' for p in job['nodes']};roster={p['node_id']:bytes.fromhex(p['public_key']) for p in job['nodes']};roster[own]=key.public_key().public_bytes_raw()
    domains={p['node_id']:job['failure_domains'][p['node_id']] for p in job['nodes']}
    stopped=threading.Event()
    for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,lambda *_:stopped.set())
    with ExitStack() as stack:
        directory=ConsensusDirectory(str(target/'directory.sqlite'),config['verifier_binary'],config['genesis']);stack.callback(directory.close)
        assessor=validator_identity(ROOT/'consensus/config/priv_validator_key.json',directory.placement_assessors)
        verifier=EnvelopeVerifier(config['network'],own,roster,str(target/'replays.sqlite'));stack.callback(verifier.close);verifier.secure_transport=ConfiguredHttpsTransport(peers,context=context)
        capacity=CapacityAssessor(directory,assessor,key,verifier,peers,domains,CapacityPolicy(**job['capacity_policy']))
        sources=[GatewaySource(config['consensus_gateways'][0])];updater=ConsensusUpdater(directory,sources).start();stack.callback(updater.stop)
        registration=PointRegistration(key,directory,sources,config['point_registration'],9444,target/'tls.pem',target/'tls.key');stack.callback(registration.stop)
        store=BlobStore(str(target/'blobs.sqlite'),max_bytes=1048576);stack.callback(store.close)
        server=TLSMeshServer(('0.0.0.0',9444),key,verifier,store,certificate=str(target/'tls.pem'),private_key=str(target/'tls.key'),directory=directory,capacity_assessor=capacity,readiness=lambda:updater.status()['ready'] and registration.status()['ready'],max_connections=8)
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start();registration.server=server;registration.start()
        try:stopped.wait()
        finally:registration.stop();server.shutdown();server.server_close();server.drain(10)


def enable_controller(job,config,receipt,folder):
    from sfera_mesh.point_join import write_private
    if receipt['host']!=job['target_host']:raise ValueError('controller_host_pin')
    target=ROOT/'trial-controller';target.mkdir(mode=0o700,exist_ok=True)
    write_private(target/'job.json',json.dumps(job).encode())
    import zipfile
    with zipfile.ZipFile(sys.argv[0]) as archive:write_private(target/'daemon.py',archive.read('server_wan_managed.py'))
    python=ROOT/'code/environment/venv/bin/python'
    text='[Unit]\nDescription=Sphere same-owner WAN placement controller\nAfter=network-online.target\n[Service]\nUser=root\nExecStart='+str(python)+' -B '+str(target/'daemon.py')+' --controller\nRestart=on-failure\nRestartSec=5\nUMask=0077\nNoNewPrivileges=true\nStandardOutput=append:'+str(target/'daemon.log')+'\nStandardError=append:'+str(target/'daemon.log')+'\n[Install]\nWantedBy=multi-user.target\n'
    path=Path('/etc/systemd/system/sphere-trial-controller.service')
    if path.exists() and path.read_text()!=text:raise ValueError('existing_controller_service_preserved')
    write_private(path,text.encode());subprocess.run(['systemctl','daemon-reload'],check=True,timeout=30);subprocess.run(['systemctl','enable',path.name],check=True,timeout=30);started=time.time();subprocess.run(['systemctl','restart',path.name],check=True,timeout=90)
    deadline=time.monotonic()+60
    while True:
        status=target/'status.json'
        if status.exists() and status.stat().st_mtime>=started and json.loads(status.read_bytes())['runtime']['running']:break
        if time.monotonic()>deadline:raise TimeoutError('controller_status_not_ready')
        time.sleep(1)
    return {'passed':True,'controller_service_started':True,'controller_status_ready':True,'point_configuration_changed':False,'placement_proof_pending':True}


def controller_daemon():
    from sfera_mesh.identity import load_identity,node_id,EnvelopeVerifier
    from sfera_mesh.consensus_directory import ConsensusDirectory
    from sfera_mesh.consensus_gateway import GatewaySource
    from sfera_mesh.consensus_updater import ConsensusUpdater
    from sfera_mesh.public_transport import DiscoveredHttpsTransport
    from sfera_mesh.controller_runtime import ControllerRuntime
    from sfera_mesh.controller_runtime import ControllerLoop
    from sfera_mesh.capacity_renewal import CapacityRenewal
    from sfera_mesh.point_join import write_private
    import sfera_mesh.initial_controller as initial_module
    original_exchange=initial_module.exchange
    def observed_exchange(*args,**kwargs):
        from urllib.error import HTTPError
        for attempt in range(3):
            try:return original_exchange(*args,**kwargs)
            except (OSError,ValueError) as error:
                print(json.dumps({'initial_exchange_error':type(error).__name__,'detail':str(error)[:240],'peer':args[3],'attempt':attempt+1}),flush=True)
                if isinstance(error,HTTPError):error.close()
                if attempt==2:raise
                time.sleep(2)
    initial_module.exchange=observed_exchange
    target=ROOT/'trial-controller';config=json.loads((ROOT/'data/point.json').read_bytes());job=json.loads((target/'job.json').read_bytes());key=load_identity(config['node_key']);own=node_id(key.public_key().public_bytes_raw())
    os.environ['SSL_CERT_FILE']=config['point_registration']['ca_certificate'];context=ssl.create_default_context(cafile=os.environ['SSL_CERT_FILE'])
    peers={p['node_id']:{'public_key':p['public_key'],'endpoint':'https://'+p['host']+':8443'} for p in job['nodes']};peers.update({p['node_id']:{'public_key':p['public_key'],'endpoint':p['endpoint']} for p in job['assessment_inventory']})
    assessors={p['assessor']:{'observer':p['node_id'],'endpoint':p['endpoint']} for p in job['assessment_inventory']}
    policy={'initial_count':1,'discovery':True}
    stopped=threading.Event()
    for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,lambda *_:stopped.set())
    with ExitStack() as stack:
        directory=ConsensusDirectory(str(target/'directory.sqlite'),config['verifier_binary'],config['genesis']);stack.callback(directory.close);source=GatewaySource(config['consensus_gateways'][0]);directory.refresh(source)
        roster={n:bytes.fromhex(p['public_key']) for n,p in peers.items()};verifier=EnvelopeVerifier(config['network'],own,roster,str(target/'replays.sqlite'));stack.callback(verifier.close);verifier.secure_transport=DiscoveredHttpsTransport({n:p['endpoint'] for n,p in peers.items()},directory,roster,context=context)
        updater=ConsensusUpdater(directory,[source]).start();stack.callback(updater.stop)
        runtime=ControllerRuntime(target,directory,source,key,verifier,peers,policy);stack.callback(runtime.close);runtime.start()
        all_targets=job.get('capacity_all_after_initial') is True
        if all_targets and runtime.controllers[0].status()['state']!='confirmed':raise ValueError('confirmed_initial_batch_before_full_capacity')
        targets=sorted(job['failure_domains']) if all_targets else sorted(job['failure_domains'])[:3]
        domains={n:job['failure_domains'][n] for n in targets}
        capacity=CapacityRenewal(target/('controller-capacity.sqlite' if all_targets else 'capacity-bootstrap-three.sqlite'),directory,source,key,verifier,assessors,domains,slots=2);stack.callback(capacity.close)
        capacity_loop=ControllerLoop('capacity-bootstrap',[(n,lambda n=n:capacity.step(n)) for n in domains]);capacity_loop.start();stack.callback(capacity_loop.stop)
        while not stopped.wait(2):
            if not all_targets and runtime.controllers[0].status()['state']=='confirmed':
                # Freeze the first candidate pool until its batch commits, then
                # resume assessment of the complete signed inventory automatically.
                capacity_loop.stop();capacity.close();all_targets=True;domains=dict(job['failure_domains'])
                capacity=CapacityRenewal(target/'controller-capacity.sqlite',directory,source,key,verifier,assessors,domains,slots=2);stack.callback(capacity.close)
                capacity_loop=ControllerLoop('capacity-all',[(n,lambda n=n:capacity.step(n)) for n in sorted(domains)]);capacity_loop.start();stack.callback(capacity_loop.stop)
            with directory.lock:
                state=directory.current['state'];observed={'height':state['height'],'resources':state.get('resources',{}),'placements':state.get('placements',{}),'manifests':state.get('manifests',{})}
            status=runtime.status();status['roles']['capacity-bootstrap']=capacity_loop.status();status['running']=status['running'] and capacity_loop.status()['running']
            write_private(target/'status.json',json.dumps({'runtime':status,'observed':observed,'capacity_scope':list(domains)}).encode())
            if not runtime.status()['running']:raise RuntimeError('controller_loop_stopped')


def managed_data(job,config,receipt,folder):
    from sfera_mesh.identity import load_identity,node_id,EnvelopeVerifier
    from sfera_mesh.consensus_directory import ConsensusDirectory
    from sfera_mesh.consensus_gateway import GatewaySource
    from sfera_mesh.network_peers import approved_network_peers
    from sfera_mesh.public_transport import ConfiguredHttpsTransport
    from sfera_mesh.manifest_publisher import ManifestPublisher
    from server_wan_trial_job import dataset
    key=load_identity(config['node_key']);own=node_id(key.public_key().public_bytes_raw());source=GatewaySource(config['consensus_gateways'][0]);context=ssl.create_default_context(cafile=config['point_registration']['ca_certificate'])
    with ExitStack() as stack:
        directory=ConsensusDirectory(str(folder/'directory.sqlite'),config['verifier_binary'],config['genesis']);stack.callback(directory.close)
        deadline=time.monotonic()+300;last=None
        while True:
            directory.refresh(source)
            with directory.lock:
                state=directory.current['state'];matches=[(c,p) for c,p in state.get('placements',{}).items() if own in p['record']['body']['members']]
            if matches:break
            if time.monotonic()>deadline:raise TimeoutError('managed_placement_not_confirmed')
            if last!=len(state.get('resources',{})):last=len(state.get('resources',{}));print('SPHERE_MANAGED_RESOURCES='+str(last),flush=True)
            time.sleep(3)
        cluster,placement=sorted(matches)[0];members=placement['record']['body']['members'];roster=approved_network_peers(directory)
        from sfera_mesh.discovery import discovered_peers
        discovered=discovered_peers(directory,https_only=True)['peers'];endpoints={n:discovered[n]['endpoint'] for n in members};transport=ConfiguredHttpsTransport(endpoints,context=context)
        verifier=EnvelopeVerifier(config['network'],own,roster,str(folder/'replays.sqlite'));stack.callback(verifier.close);verifier.secure_transport=transport
        rows,cipher,aad=dataset(folder,job['job_id'],own,1,1024);row=rows[0];digest=row['digest'];size=len(row['ciphertext'])//2
        def call(node,operation,payload):
            for attempt in range(3):
                try:return transport.exchange(key,verifier,node,operation,payload)
                except (ValueError,OSError):
                    if attempt==2:raise
                    time.sleep(1)
        seeded=[own]+[n for n in members if n!=own][:1]
        for n in seeded:call(n,'put',{'digest':digest,'ciphertext':row['ciphertext']})
        publisher=ManifestPublisher(folder/'publisher.sqlite',directory,source,key,verifier,endpoints,cluster=cluster,sizes={digest:size});stack.callback(publisher.close)
        deadline=time.monotonic()+180
        while True:
            status=publisher.step()
            if status['state']=='confirmed':break
            if time.monotonic()>deadline:raise TimeoutError('managed_manifest_not_confirmed:'+str(status))
            time.sleep(2)
        deadline=time.monotonic()+120
        while True:
            verified=[]
            for n in members:
                result=call(n,'get',{'digest':digest});raw=bytes.fromhex(result.get('ciphertext',''))
                if raw and hashlib.sha256(raw).hexdigest()==digest and cipher.decrypt(raw[:12],raw[12:],aad)==row['plain']:verified.append(n)
            if len(verified)==3:break
            if time.monotonic()>deadline:raise TimeoutError('managed_third_copy_missing')
            time.sleep(3)
        directory.refresh(source)
        return {'passed':True,'cluster':cluster,'members':members,'digest':digest,'ciphertext_bytes':size,'seeded_members':seeded,'automatically_copied_members':[n for n in members if n not in seeded],'verified_decrypted_copies':len(verified),'height':directory.anchor()['height'],'placement':directory.placement(cluster),'manifest':directory.current['state']['manifests'][cluster],'placement_managed':True}


def remove_test_copy(job,config,receipt,folder):
    import sqlite3
    from sfera_mesh.consensus_directory import ConsensusDirectory
    from sfera_mesh.consensus_gateway import GatewaySource
    from sfera_mesh.identity import load_identity,node_id
    key=load_identity(config['node_key']);own=node_id(key.public_key().public_bytes_raw())
    if receipt['host']!=job['target_host'] or own not in job['test_members'] or len(job['test_members'])!=3:raise ValueError('explicit_repair_target_required')
    directory=ConsensusDirectory(str(folder/'directory.sqlite'),config['verifier_binary'],config['genesis'])
    try:
        directory.refresh(GatewaySource(config['consensus_gateways'][0]));placement=directory.placement(job['test_cluster']);manifest=directory.current['state']['manifests'][job['test_cluster']]
        if placement['record']['body']['members']!=job['test_members'] or job['test_digest'] not in manifest['record']['body']['digests']:raise ValueError('verified_trial_manifest_required')
    finally:directory.close()
    digest=job['test_digest']
    if not __import__('re').fullmatch('[0-9a-f]{64}',digest) or job['test_size']!=1052:raise ValueError('bounded_test_blob_required')
    path=Path(config['state_directory'])/'blobs.sqlite';db=sqlite3.connect(path,timeout=10)
    try:
        with db:
            db.execute('BEGIN IMMEDIATE');row=db.execute('SELECT data FROM blobs WHERE digest=?',(digest,)).fetchone()
            if not row or len(row[0])!=job['test_size'] or hashlib.sha256(row[0]).hexdigest()!=digest:raise ValueError('exact_test_ciphertext_required')
            db.execute('DELETE FROM blobs WHERE digest=?',(digest,))
        deleted_at=time.time();missing=db.execute('SELECT COUNT(*) FROM blobs WHERE digest=?',(digest,)).fetchone()[0]==0
        if not missing:raise ValueError('test_deletion_not_observed')
        print('SPHERE_TEST_COPY_MISSING '+digest,flush=True);deadline=time.monotonic()+180
        while True:
            row=db.execute('SELECT data FROM blobs WHERE digest=?',(digest,)).fetchone()
            if row and len(row[0])==job['test_size'] and hashlib.sha256(row[0]).hexdigest()==digest:break
            if time.monotonic()>deadline:raise TimeoutError('automatic_copy_repair_not_observed')
            time.sleep(.5)
        return {'passed':True,'digest':digest,'cluster':job['test_cluster'],'copy_missing_observed':True,'automatic_restore_observed':True,'seconds_to_restore':round(time.time()-deleted_at,3),'manual_put_after_delete':False,'deleted_rows':1,'ciphertext_bytes':job['test_size']}
    finally:db.close()


def diagnose(job,config,receipt,folder):
    from sfera_mesh.identity import load_identity,node_id,EnvelopeVerifier
    from sfera_mesh.consensus_directory import ConsensusDirectory
    from sfera_mesh.consensus_gateway import GatewaySource
    from sfera_mesh.initial_controller import initial_proposals
    from sfera_mesh.network_peers import approved_network_peers
    from sfera_mesh.discovery import discovered_peers
    from sfera_mesh.public_transport import ConfiguredHttpsTransport
    directory=ConsensusDirectory(str(folder/'directory.sqlite'),config['verifier_binary'],config['genesis']);key=load_identity(config['node_key'])
    try:
        directory.refresh(GatewaySource(config['consensus_gateways'][0]));plan,proposals=initial_proposals(directory,1);roster=approved_network_peers(directory);peers=discovered_peers(directory,https_only=True)['peers'];verifier=EnvelopeVerifier(config['network'],node_id(key.public_key().public_bytes_raw()),roster,str(folder/'replays.sqlite'))
        try:
            transport=ConfiguredHttpsTransport({n:p['endpoint'] for n,p in peers.items()},context=ssl.create_default_context(cafile=config['point_registration']['ca_certificate']));results=[]
            for proposal in proposals:
                for n in proposal['body']['members']:
                    try:r=transport.exchange(key,verifier,n,'initial-consent',{'count':1,'pool_hash':plan['pool_hash'],'proposal':proposal});results.append({'node':n,'consent_received':'consent' in r})
                    except Exception as e:results.append({'node':n,'error':type(e).__name__,'detail':str(e)[:300]})
            return {'passed':True,'diagnostic_only':True,'responses':results,'plan':plan}
        finally:verifier.close()
    finally:directory.close()


def verify_managed_copy(job,config,receipt,folder):
    from sfera_mesh.identity import load_identity,node_id,EnvelopeVerifier
    from sfera_mesh.consensus_directory import ConsensusDirectory
    from sfera_mesh.consensus_gateway import GatewaySource
    from sfera_mesh.network_peers import approved_network_peers
    from sfera_mesh.discovery import discovered_peers
    from sfera_mesh.public_transport import ConfiguredHttpsTransport
    from server_wan_trial_job import dataset,exercise_peer
    if not __import__('re').fullmatch('[0-9a-f]{32}',job['data_job_id']):raise ValueError('existing_trial_dataset_required')
    key=load_identity(config['node_key']);own=node_id(key.public_key().public_bytes_raw());source_folder=ROOT/'trial-tests'/job['data_job_id']
    if not (source_folder/'data-key').exists():raise ValueError('existing_trial_data_key_required')
    rows,cipher,aad=dataset(source_folder,job['data_job_id'],own,1,1024)
    if rows[0]['digest']!=job['test_digest']:raise ValueError('original_trial_digest_required')
    directory=ConsensusDirectory(str(folder/'directory.sqlite'),config['verifier_binary'],config['genesis'])
    try:
        directory.refresh(GatewaySource(config['consensus_gateways'][0]));placement=directory.placement(job['test_cluster']);members=placement['record']['body']['members']
        if members!=job['test_members'] or job['test_digest'] not in directory.current['state']['manifests'][job['test_cluster']]['record']['body']['digests']:raise ValueError('original_trial_manifest_required')
        roster=approved_network_peers(directory);peers=discovered_peers(directory,https_only=True)['peers'];transport=ConfiguredHttpsTransport({n:peers[n]['endpoint'] for n in members},context=ssl.create_default_context(cafile=config['point_registration']['ca_certificate']));verifier=EnvelopeVerifier(config['network'],own,roster,str(folder/'replays.sqlite'))
        try:results=[exercise_peer(transport,key,verifier,n,rows,cipher,aad,read_only=True,max_attempts=3) for n in members]
        finally:verifier.close()
        return {'passed':all(r['passed'] for r in results),'cluster':job['test_cluster'],'digest':job['test_digest'],'verified_decrypted_copies':sum(r['passed'] for r in results),'routes':results,'writes':0,'height':directory.anchor()['height']}
    finally:directory.close()


def managed_inventory(profile,directory):
    """Bind assessment endpoints to licensed discovery and signed host inventory."""
    from sfera_mesh.discovery import discovered_peers
    from sfera_mesh.network_peers import approved_network_peers
    peers=discovered_peers(directory,https_only=True)['peers'];roster=approved_network_peers(directory);result=[]
    for host in profile['validators']:
        node=next(n for n in profile['nodes'] if n['host']==host);public=base64.b64decode(node['validator_public_key']['value'],validate=True);assessor=hashlib.sha256(public).hexdigest()
        if directory.placement_assessors.get(assessor)!=public.hex():raise ValueError('signed_validator_assessor_mismatch')
        matches=[(identity,p) for identity,p in peers.items() if p['endpoint']=='https://'+host+':9444' and roster.get(identity)==bytes.fromhex(p['public_key'])]
        if len(matches)!=1:raise ValueError('one_licensed_assessor_endpoint_per_host_required')
        identity,entry=matches[0];result.append({'host':host,'node_id':identity,'public_key':entry['public_key'],'endpoint':entry['endpoint'],'assessor':assessor})
    if len(result)!=4 or len({p['node_id'] for p in result})!=4:raise ValueError('four_distinct_genesis_assessors_required')
    return result


def activate_roles(profile,settings,receipt):
    """Run inside the third installation command when the signed profile opts in."""
    from sfera_mesh.consensus_directory import ConsensusDirectory
    from sfera_mesh.consensus_gateway import GatewaySource
    roles=profile['managed_roles']
    if set(roles)!={'capacity_policy','failure_domains'} or set(roles['failure_domains'])!={n['node_id'] for n in profile['nodes']}:raise ValueError('complete_signed_managed_inventory_required')
    from sfera_mesh.capacity import CapacityPolicy
    CapacityPolicy(**roles['capacity_policy'])
    config=json.loads((ROOT/'data/point.json').read_bytes());folder=ROOT/'trial-setup';folder.mkdir(mode=0o700,exist_ok=True)
    job={'network':profile['network'],'ownership_model':profile['ownership_model'],'nodes':profile['nodes'],**roles}
    results={'host':receipt['host'],'assessment_service':False,'controller_service':False}
    if receipt['host'] in profile['validators']:
        prepare(job,config,receipt,folder);results['assessment_service']=True
    if receipt['host']==profile['bootstrap_host']:
        directory=ConsensusDirectory(str(folder/'managed-directory.sqlite'),config['verifier_binary'],config['genesis']);deadline=time.monotonic()+600
        try:
            while True:
                try:directory.refresh(GatewaySource(config['consensus_gateways'][0]));inventory=managed_inventory(profile,directory);break
                except (OSError,ValueError):
                    if time.monotonic()>deadline:raise
                    time.sleep(3)
        finally:directory.close()
        enable_controller({**job,'target_host':receipt['host'],'assessment_inventory':inventory},config,receipt,folder);results['controller_service']=True
    return results


if __name__=='__main__':
    settings=json.loads((ROOT/'code/preparing.json').read_bytes());version=Path(settings['version']);sys.path[:0]=[str(version/'scripts'),str(version/'django-server/sfera_server')]
    if '--controller' in sys.argv:controller_daemon()
    else:daemon()


