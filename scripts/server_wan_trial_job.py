"""Bounded same-owner WAN workload and reversible service-failure exercises."""
from concurrent.futures import ThreadPoolExecutor,as_completed
import hashlib
import json
import math
import os
import re
from pathlib import Path
import signal
import subprocess
import sys
import time
import zipfile

ROOT=Path('/opt/sphere-point')


def encoded(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()


def resource_sample(config):
    import shutil
    memory={line.split(':')[0]:int(line.split()[1])*1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith(('MemAvailable:','MemTotal:'))}
    status=json.loads((Path(config['state_directory'])/'status.json').read_bytes());pid=status['process_id'];rss=None
    try:
        for line in Path('/proc/'+str(pid)+'/status').read_text().splitlines():
            if line.startswith('VmRSS:'):rss=int(line.split()[1])*1024
    except FileNotFoundError:pass
    return {'time':time.time(),'available_memory_bytes':memory['MemAvailable'],'total_memory_bytes':memory['MemTotal'],'load_average_1m':os.getloadavg()[0],'point_rss_bytes':rss,'point_pid':pid,'disk_free_bytes':shutil.disk_usage(config['state_directory']).free}


def atomic(path,value):
    path=Path(path);temporary=path.with_name(path.name+'.pending')
    if temporary.is_symlink() or path.is_symlink():raise ValueError('trial_result_link')
    with os.fdopen(os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),'wb') as stream:stream.write(encoded(value));stream.flush();os.fsync(stream.fileno())
    os.replace(temporary,path)


def dataset(folder,dataset_id,origin,blocks,size):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if type(blocks) is not int or type(size) is not int or not 1<=blocks<=64 or not 1024<=size<=16384 or blocks*size>1048576:raise ValueError('bounded_trial_dataset_required')
    context={'dataset':dataset_id,'origin':origin,'blocks':blocks,'size':size};context_file=folder/'dataset.json';key_file=folder/'data-key'
    if context_file.exists():
        if json.loads(context_file.read_bytes())!=context or not key_file.is_file():raise ValueError('existing_trial_dataset_preserved')
    else:
        if key_file.exists():raise ValueError('incomplete_trial_dataset')
        with os.fdopen(os.open(key_file,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as stream:stream.write(os.urandom(32));stream.flush();os.fsync(stream.fileno())
        atomic(context_file,context)
    if key_file.is_symlink() or key_file.stat().st_mode&0o077:raise ValueError('private_trial_data_key_required')
    key=key_file.read_bytes();aad=encoded(context);cipher=AESGCM(key);rows=[]
    for number in range(blocks):
        seed=encoded([dataset_id,origin,number]);plain=hashlib.shake_256(seed).digest(size);nonce=hashlib.sha256(seed).digest()[:12];raw=nonce+cipher.encrypt(nonce,plain,aad)
        rows.append({'digest':hashlib.sha256(raw).hexdigest(),'ciphertext':raw.hex(),'plain':plain})
    return rows,cipher,aad


def exercise_peer(transport,key,verifier,peer,rows,cipher,aad,*,read_only=False,max_attempts=1):
    if type(max_attempts) is not int or not 1<=max_attempts<=3:raise ValueError('bounded_trial_retries_required')
    latencies=[];failures=[];attempt_errors=[];written=read=put_attempts=get_attempts=recovered=0
    for index,row in enumerate(rows):
        start=time.monotonic()
        stored=False
        for attempt in range(max_attempts):
            operation='get'
            try:
                if not read_only and not stored:
                    operation='put';put_attempts+=1;transport.exchange(key,verifier,peer,'put',{'digest':row['digest'],'ciphertext':row['ciphertext']});written+=len(row['ciphertext'])//2;stored=True
                operation='get';get_attempts+=1;result=transport.exchange(key,verifier,peer,'get',{'digest':row['digest']})
                if result.get('digest')!=row['digest'] or result.get('ciphertext')!=row['ciphertext']:raise ValueError('trial_ciphertext_mismatch')
                raw=bytes.fromhex(result['ciphertext'])
                if cipher.decrypt(raw[:12],raw[12:],aad)!=row['plain']:raise ValueError('trial_decryption_mismatch')
                read+=len(raw)
                if attempt:recovered+=1
                break
            except Exception as error:
                item={'block':index,'attempt':attempt+1,'operation':operation,'error':type(error).__name__,'detail':str(error)[:120]};attempt_errors.append(item)
                if attempt+1==max_attempts:failures.append(item)
                else:time.sleep(.2*(attempt+1))
        latencies.append(round((time.monotonic()-start)*1000))
    values=sorted(latencies)
    return {'peer':peer,'blocks':len(rows),'failures':failures,'attempt_errors':attempt_errors,'recovered_blocks':recovered,'put_attempts':put_attempts,'get_attempts':get_attempts,'written_bytes':written,'verified_read_bytes':read,'p95_put_get_ms':values[math.ceil(len(values)*.95)-1],'passed':not failures}


def service_fault(job,folder,config,key):
    from server_monitor import check
    import ssl
    unit={'point_restart':'sphere-point.service','validator_pause':'sphere-trial-validator.service','seed_pause':'sphere-trial-seed.service'}[job['action']]
    if config['public_endpoint'].split('://')[1].split(':')[0]!=job['target_host']:raise ValueError('fault_target_host_mismatch')
    duration=job['pause_seconds']
    if type(duration) is not int or not 5<=duration<=30:raise ValueError('bounded_trial_pause_required')
    def command(argv):return subprocess.run(argv,check=True,timeout=90,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    command(['systemctl','is-active','--quiet',unit]);timer='sphere-trial-recover-'+job['job_id'][:16]
    command(['systemd-run','--unit='+timer,'--on-active=90','/usr/bin/systemctl','start',unit])
    before=None;sign_file=ROOT/'consensus/data/priv_validator_state.json'
    if job['action']=='validator_pause':before=int(json.loads(sign_file.read_bytes())['height'])
    try:
        command(['systemctl','stop',unit]);atomic(folder/'fault-state.json',{'phase':'stopped','unit':unit,'started_at':time.time(),'duration':duration,'last_signed_height_before':before});print('SPHERE_TEST_STOPPED '+unit,flush=True)
        time.sleep(duration)
    finally:
        command(['systemctl','start',unit]);atomic(folder/'fault-state.json',{'phase':'restarted','unit':unit,'restarted_at':time.time()})
        subprocess.run(['systemctl','stop',timer+'.timer'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
    deadline=time.monotonic()+120;context=ssl.create_default_context(cafile=config['point_registration']['ca_certificate'])
    while True:
        ready=check(config['public_endpoint'],context=context,key=key,network=config['network'])['ready']
        after=int(json.loads(sign_file.read_bytes())['height']) if before is not None else None
        if ready and (before is None or after>before):break
        if time.monotonic()>deadline:raise ValueError('trial_service_recovery_timeout')
        time.sleep(2)
    return {'action':job['action'],'pause_seconds':duration,'ready_after_restart':True,'last_signed_height_before':before,'last_signed_height_after':after,'signing_state_reset':False,'passed':True}


def partition(job,folder,config):
    """Only trial validator P2P traffic; SSH and point HTTPS are untouched."""
    import ipaddress,shutil
    if config['public_endpoint']!='https://'+job['target_host']+':8443' or not 5<=job['pause_seconds']<=30:raise ValueError('bounded_partition_target_required')
    peers=job['partition_peers']
    if len(peers)!=3 or len(set(peers))!=3 or any(str(ipaddress.IPv4Address(p))!=p or p==job['target_host'] for p in peers):raise ValueError('three_other_validator_ipv4_required')
    tool=shutil.which('iptables')
    if not tool:raise ValueError('iptables_required_for_bounded_trial')
    incoming='SPHI'+job['job_id'][:12];outgoing='SPHO'+job['job_id'][:12]
    def command(argv,check=True):return subprocess.run(argv,check=check,capture_output=True,timeout=30)
    cleanup=folder/'remove-partition.py'
    text='import subprocess\n'
    for parent,chain in [('INPUT',incoming),('OUTPUT',outgoing)]:
        for args in [ ['-D',parent,'-j',chain],['-F',chain],['-X',chain] ]:text+='subprocess.run('+repr([tool,'-w','5',*args])+',check=False,timeout=30)\n'
    with os.fdopen(os.open(cleanup,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as output:output.write(text)
    timer='sphere-trial-unpartition-'+job['job_id'][:16];sign_file=ROOT/'consensus/data/priv_validator_state.json';before=int(json.loads(sign_file.read_bytes())['height'])
    # Even an interrupted SSH connection cannot leave this partition permanent.
    command(['systemd-run','--unit='+timer,'--on-active=90',sys.executable,'-B',str(cleanup)])
    try:
        for parent,chain,flag in [('INPUT',incoming,'-s'),('OUTPUT',outgoing,'-d')]:
            command([tool,'-w','5','-N',chain])
            for peer in peers:
                for port in ('--sport','--dport'):command([tool,'-w','5','-A',chain,'-p','tcp',flag,peer,port,'26656','-j','DROP'])
            command([tool,'-w','5','-I',parent,'1','-j',chain])
        atomic(folder/'fault-state.json',{'phase':'partitioned','started_at':time.time(),'duration':job['pause_seconds'],'peers':peers,'port':26656});print('SPHERE_TEST_PARTITIONED',flush=True);time.sleep(job['pause_seconds'])
    finally:
        subprocess.run([sys.executable,'-B',str(cleanup)],check=True,timeout=180)
        removed=all(command([tool,'-w','5','-S',chain],check=False).returncode!=0 for chain in (incoming,outgoing))
        if removed:command(['systemctl','stop',timer+'.timer'],check=False)
        atomic(folder/'fault-state.json',{'phase':'unpartitioned','temporary_chains_removed':removed,'finished_at':time.time()})
    if not removed:raise ValueError('temporary_partition_cleanup_unconfirmed')
    deadline=time.monotonic()+120
    while True:
        after=int(json.loads(sign_file.read_bytes())['height'])
        if after>before+3:break
        if time.monotonic()>deadline:raise TimeoutError('partition_signer_catchup_timeout')
        time.sleep(2)
    return {'passed':True,'action':job['action'],'pause_seconds':job['pause_seconds'],'last_signed_height_before':before,'last_signed_height_after':after,'temporary_chains_removed':removed,'ssh_port_filtered':False,'point_https_filtered':False,'signing_state_reset':False}


def main():
    os.umask(0o077)
    with zipfile.ZipFile(sys.argv[0]) as archive:job=json.loads(archive.read('job.json'))
    if job['ownership_model']!='same-owner-simulation' or job['action'] not in ('storage_load','verify_storage','soak_read','point_restart','validator_pause','seed_pause','validator_partition','managed_prepare','managed_enable','managed_data','managed_remove','managed_diagnose','managed_verify'):raise ValueError('explicit_trial_job_required')
    if not re.fullmatch('[0-9a-f]{16,64}',job['job_id']) or ('dataset_id' in job and not re.fullmatch('[0-9a-f]{16,64}',job['dataset_id'])):raise ValueError('simple_trial_job_identity_required')
    settings=json.loads((ROOT/'code/preparing.json').read_bytes());version=Path(settings['version']);sys.path[:0]=[str(version/'scripts'),str(version/'django-server/sfera_server')]
    if 'transport_timeout_seconds' in job:
        timeout=job['transport_timeout_seconds']
        if type(timeout) is not int or not 1<=timeout<=10:raise ValueError('bounded_trial_transport_timeout')
        # Publisher-signed client modules are loaded from this job archive only;
        # installed point code and its release/update protection remain intact.
        import sfera_mesh
        sfera_mesh.__path__.insert(0,str(sys.argv[0])+'/sfera_mesh')
    from sfera_mesh.identity import load_identity,node_id,EnvelopeVerifier
    from sfera_mesh.consensus_directory import ConsensusDirectory
    from sfera_mesh.consensus_gateway import GatewaySource
    from sfera_mesh.network_peers import approved_network_peers
    from sfera_mesh.public_transport import ConfiguredHttpsTransport
    from server_monitor import check
    import ssl
    config=json.loads((ROOT/'data/point.json').read_bytes());receipt=json.loads((ROOT/'activation.json').read_bytes());key=load_identity(config['node_key']);own=node_id(key.public_key().public_bytes_raw())
    if job['network']!=config['network'] or own!=receipt['node_id']:raise ValueError('trial_identity_context')
    base=ROOT/'trial-tests';base.mkdir(mode=0o700,exist_ok=True);folder=base/job['job_id'];folder.mkdir(mode=0o700,exist_ok=True)
    os.environ['SSL_CERT_FILE']=config['point_registration']['ca_certificate'];context=ssl.create_default_context(cafile=os.environ['SSL_CERT_FILE'])
    if not check(config['public_endpoint'],context=context,key=key,network=config['network'])['ready']:raise ValueError('trial_point_not_ready')
    if job['action']=='managed_prepare':
        from server_wan_managed import prepare
        result=prepare(job,config,receipt,folder)
    elif job['action']=='managed_enable':
        from server_wan_managed import enable_controller
        result=enable_controller(job,config,receipt,folder)
    elif job['action'] in ('managed_data','managed_remove'):
        from server_wan_managed import managed_data,remove_test_copy
        result=(managed_data if job['action']=='managed_data' else remove_test_copy)(job,config,receipt,folder)
    elif job['action']=='managed_diagnose':
        from server_wan_managed import diagnose
        result=diagnose(job,config,receipt,folder)
    elif job['action']=='managed_verify':
        from server_wan_managed import verify_managed_copy
        result=verify_managed_copy(job,config,receipt,folder)
    elif job['action'] in ('point_restart','validator_pause','seed_pause'):result=service_fault(job,folder,config,key)
    elif job['action']=='validator_partition':result=partition(job,folder,config)
    else:
        directory=ConsensusDirectory(str(folder/'directory.sqlite'),config['verifier_binary'],config['genesis'])
        try:directory.refresh(GatewaySource(config['consensus_gateways'][0]));roster=approved_network_peers(directory)
        finally:directory.close()
        expected={p['node_id']:bytes.fromhex(p['public_key']) for p in job['nodes']}
        if any(roster.get(node)!=public for node,public in expected.items()):raise ValueError('trial_fresh_membership_required')
        peers={p['node_id']:'https://'+p['host']+':8443' for p in job['nodes'] if p['node_id']!=own and (not job.get('target_host') or p['host']==job['target_host'])}
        if not peers:raise ValueError('trial_other_peer_required')
        data_folder=base/job['dataset_id'];data_folder.mkdir(mode=0o700,exist_ok=True);rows,cipher,aad=dataset(data_folder,job['dataset_id'],own,job['blocks'],job['block_bytes'])
        verifier=EnvelopeVerifier(config['network'],own,roster,str(folder/'replays.sqlite'));transport=ConfiguredHttpsTransport(peers,context=context,**({'timeout_seconds':job['transport_timeout_seconds']} if 'transport_timeout_seconds' in job else {}));started=time.monotonic()
        rounds=[];samples=[];soak=job['action']=='soak_read'
        if soak and (type(job.get('soak_seconds')) is not int or not 60<=job['soak_seconds']<=300):raise ValueError('bounded_soak_duration_required')
        try:
            for number in range(12 if soak else 1):
                samples.append(resource_sample(config))
                with ThreadPoolExecutor(max_workers=3) as pool:
                    futures=[pool.submit(exercise_peer,transport,key,verifier,peer,rows,cipher,aad,read_only=job['action'] in ('verify_storage','soak_read'),max_attempts=job.get('max_attempts',1)) for peer in peers];results=[f.result() for f in futures]
                rounds.append(results);samples.append(resource_sample(config))
                if soak:print('SPHERE_SOAK_ROUND='+str(number+1)+' elapsed='+str(round(time.monotonic()-started,1)),flush=True)
                if not soak or time.monotonic()-started>=job['soak_seconds'] or any(not r['passed'] for r in results):break
        finally:verifier.close()
        result={'action':job['action'],'dataset_id':job['dataset_id'],'origin_node_id':own,'blocks_per_peer':len(rows),'ciphertext_bytes_per_block':len(rows[0]['ciphertext'])//2,'routes':results,'elapsed_seconds':round(time.monotonic()-started,2),'digests':[r['digest'] for r in rows],'placement_managed':False,'passed':all(r['passed'] for group in rounds for r in group)}
        if soak:result.update(rounds=rounds,resource_samples=samples,writes=0,minimum_duration_seconds=job['soak_seconds'],duration_reached=time.monotonic()-started>=job['soak_seconds'],transport_timeout_seconds=job.get('transport_timeout_seconds',3));result['passed']=result['passed'] and (not soak or result['duration_reached'])
    result.update(host=receipt['host'],network=config['network'],job_id=job['job_id'],ownership_model=job['ownership_model']);atomic(folder/'result.json',result);print('SPHERE_TRIAL_RESULT='+encoded(result).decode(),flush=True)
    if not result['passed']:raise SystemExit(1)


if __name__=='__main__':main()
