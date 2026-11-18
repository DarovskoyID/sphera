"""Headless TLS mesh service with explicit operator trust and persistent state.

Requires a pinned genesis, verifier, node identity and TLS certificate.
An explicitly provisioned publisher role can admit ordinary points. No UI or DB migrations.
"""
import argparse
from contextlib import ExitStack
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import threading
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'django-server'/'sfera_server'))
from release_v1 import parse,canonical,HEX
from server_state import point_lock
from sfera_mesh.identity import create_identity,load_identity,node_id,EnvelopeVerifier
from sfera_mesh.public_transport import TLSMeshServer,ConfiguredHttpsTransport,DiscoveredHttpsTransport,endpoint_url
from sfera_mesh.transport import BlobStore
from sfera_mesh.consensus_directory import ConsensusDirectory,validate_address
from sfera_mesh.consensus_updater import ConsensusUpdater
from sfera_mesh.replacement import PlacementSigner
from sfera_mesh.capacity import CapacitySampler
from sfera_mesh.auth import MeshAuth
from sfera_mesh.health import HealthJournal,HealthMonitor
from sfera_mesh.replica_worker import VerifiedReplicaWorker
from sfera_mesh.controller_runtime import ControllerRuntime,validate_policy,database_names
from sfera_mesh.assessment_service import validate_assessment,assessment_binding,provision_assessment
from sfera_mesh.consensus_gateway import GatewaySource,ConsensusGateway
from sfera_mesh.point_join import PointRegistration
from sfera_mesh.network_peers import approved_network_peers
from mesh_enrollment import validate_enrollment,enrollment_binding,provision_enrollment


def consensus_sources(value):
    return [GatewaySource(url) for url in value.get('consensus_gateways',[])] or value['consensus_rpc']


def validate_config(value):
    required={'domain','network','listen_host','listen_port','public_endpoint','state_directory','node_key','genesis','genesis_sha256',
        'verifier_binary','verifier_sha256','tls_certificate','tls_private_key','peers','consensus_rpc','max_blob_bytes','max_connections'}
    if not isinstance(value,dict) or not required<=set(value)<=required|{'health_observer','replication_worker','controllers','assessment_service','consensus_gateways','serve_consensus','follow_network_peers','point_registration','enrollment_service'} or value['domain']!='sphere-mesh-point-runtime-v1':raise ValueError('mesh_point_configuration_schema')
    if 'enrollment_service' in value:
        validate_enrollment(value['enrollment_service'])
        if not value.get('serve_consensus') or 'point_registration' in value:raise ValueError('publisher_enrollment_requires_local_gateway')
    if 'follow_network_peers' in value and type(value['follow_network_peers']) is not bool:raise ValueError('explicit_follow_network_peers_required')
    if 'point_registration' in value:
        policy=value['point_registration']
        if not isinstance(policy,dict) or set(policy)!={'enrollment','ca_certificate','ca_sha256'} or not value.get('follow_network_peers'):raise ValueError('automatic_point_registration_schema')
        endpoint_url(policy['enrollment'])
        if not isinstance(policy['ca_certificate'],str) or not Path(policy['ca_certificate']).is_absolute() or not isinstance(policy['ca_sha256'],str) or not HEX.fullmatch(policy['ca_sha256']):raise ValueError('pinned_network_ca_required')
    if 'health_observer' in value and type(value['health_observer']) is not bool:raise ValueError('explicit_health_observer_boolean_required')
    if 'replication_worker' in value and type(value['replication_worker']) is not bool:raise ValueError('explicit_replication_worker_boolean_required')
    if not isinstance(value['network'],str) or not 1<=len(value['network'])<=128:raise ValueError('mesh_point_network_required')
    ipaddress.ip_address(value['listen_host'])
    if type(value['listen_port']) is not int or not 1024<=value['listen_port']<=65535:raise ValueError('unprivileged_tls_port_required')
    endpoint_url(value['public_endpoint'])
    for field in ('state_directory','node_key','genesis','verifier_binary','tls_certificate','tls_private_key'):
        if not isinstance(value[field],str) or not Path(value[field]).is_absolute():raise ValueError('absolute_operator_paths_required')
    for field in ('genesis_sha256','verifier_sha256'):
        if not isinstance(value[field],str) or not HEX.fullmatch(value[field]):raise ValueError('independent_genesis_and_verifier_pins_required')
    if type(value['max_blob_bytes']) is not int or not 1<=value['max_blob_bytes']<=2**53-1:raise ValueError('explicit_storage_quota_required')
    if type(value['max_connections']) is not int or not 1<=value['max_connections']<=256:raise ValueError('explicit_connection_limit_required')
    if not isinstance(value['consensus_rpc'],list) or not 0<=len(value['consensus_rpc'])<=16:raise ValueError('local_validator_rpc_required')
    if 'consensus_gateways' in value:
        gateways=value['consensus_gateways']
        if not isinstance(gateways,list) or not 1<=len(gateways)<=8 or value['consensus_rpc']:raise ValueError('exclusive_bounded_consensus_gateways_required')
        for url in gateways:GatewaySource(url)
    elif not value['consensus_rpc']:raise ValueError('local_validator_rpc_required')
    if 'serve_consensus' in value and (type(value['serve_consensus']) is not bool or value['serve_consensus'] and not value['consensus_rpc']):raise ValueError('gateway_server_requires_local_validator')
    if value.get('replication_worker',False) and len(value['consensus_rpc'])>8:raise ValueError('bounded_replication_bootstrap_required')
    for address in value['consensus_rpc']:validate_address(address)
    if not isinstance(value['peers'],dict) or not 1<=len(value['peers'])<=128:raise ValueError('explicit_operator_roster_required')
    if value.get('health_observer',False) and not 2<=len(value['peers'])<=64:raise ValueError('bounded_health_observer_peers_required')
    for peer,entry in value['peers'].items():
        if not isinstance(entry,dict) or set(entry)!={'public_key','endpoint'}:raise ValueError('operator_peer_schema')
        public=bytes.fromhex(entry['public_key'])
        if len(public)!=32 or node_id(public)!=peer:raise ValueError('operator_peer_identity_mismatch')
        endpoint_url(entry['endpoint'])
    if 'controllers' in value:validate_policy(value['controllers'],value['peers'])
    if 'assessment_service' in value:
        validate_assessment(value['assessment_service'],value['peers'])
        if not value.get('health_observer') or set(value.get('controllers',{}))&{'capacity','failure'}:raise ValueError('independent_assessment_process_with_health_required')
    return value


def check_file(path,digest=None):
    path=Path(path)
    if path.is_symlink() or not path.is_file():raise ValueError('regular_operator_file_required')
    if digest is not None:
        with path.open('rb') as source:actual=hashlib.file_digest(source,'sha256').hexdigest()
        if actual!=digest:raise ValueError('operator_file_pin_mismatch')
    return path


def preflight(value):
    """Read-only operator-input verification; never starts listeners or point DBs."""
    import ssl
    validate_config(value);genesis=check_file(value['genesis'],value['genesis_sha256']);check_file(value['verifier_binary'],value['verifier_sha256'])
    if parse(genesis.read_bytes(),4*1024*1024).get('chain_id')!=value['network']:raise ValueError('genesis_network_mismatch')
    private=check_file(value['node_key'])
    if sys.platform=='linux' and private.stat().st_mode&0o077:raise ValueError('node_identity_requires_private_permissions')
    key=load_identity(private);identity=node_id(key.public_key().public_bytes_raw())
    if value['peers'].get(identity)!={'public_key':key.public_key().public_bytes_raw().hex(),'endpoint':value['public_endpoint']}:raise ValueError('own_operator_identity_not_provisioned')
    cert=check_file(value['tls_certificate']);tlskey=check_file(value['tls_private_key'])
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(cert,tlskey)
    result={'domain':'sphere-point-preflight-v1','node':identity,'network':value['network'],'files_verified':True,'listeners_started':False,'network_verified':False,'point_state_changed':False}
    # Read genesis policy through the same parser used by runtime. Only this
    # disposable verification DB is created, never the configured point state.
    with tempfile.TemporaryDirectory(prefix='sphere-point-preflight-') as temporary:
        directory=ConsensusDirectory(str(Path(temporary)/'verify.sqlite'),value['verifier_binary'],genesis)
        try:
            if 'enrollment_service' in value:
                enrollment=provision_enrollment(value['enrollment_service'],directory,str(Path(temporary)/'enrollment.sqlite'),check_file)
                enrollment.close();result['enrollment_service_verified']=True
            if 'controllers' in value or 'assessment_service' in value:
                if directory.endpoint_policy!='https-v1':raise ValueError('controller_genesis_https_policy_required')
            for role in ('capacity','failure'):
                if role in value.get('controllers',{}) and set(value['controllers'][role]['assessors'])!=set(directory.placement_assessors):raise ValueError('genesis_assessor_inventory_mismatch')
            if 'assessment_service' in value:
                policy=value['assessment_service'];path=check_file(policy['assessor_key'],policy['assessor_sha256'])
                if sys.platform=='linux' and path.stat().st_mode&0o077:raise ValueError('assessment_key_requires_private_permissions')
                assessor_key=load_identity(path);public=assessor_key.public_key().public_bytes_raw();assessor=hashlib.sha256(public).hexdigest()
                if set(policy['bindings'])!=set(directory.placement_assessors) or directory.placement_assessors.get(assessor)!=public.hex() or policy['bindings'].get(assessor)!=identity:raise ValueError('assessment_identity_must_be_provisioned_in_genesis')
                result['assessor']=assessor
        finally:directory.close()
    return result


def run(value):
    validate_config(value)
    if sys.platform!='linux':raise ValueError('mesh_point_runtime_requires_linux')
    if 'point_registration' in value:
        policy=value['point_registration'];check_file(policy['ca_certificate'],policy['ca_sha256']);os.environ['SSL_CERT_FILE']=policy['ca_certificate']
    if 'SPHERE_SUPERVISOR_PID' in os.environ:
        # A killed supervisor must not leave an orphan holding the state lock.
        import ctypes
        expected=int(os.environ['SPHERE_SUPERVISOR_PID'])
        libc=ctypes.CDLL(None,use_errno=True)
        libc.prctl.argtypes=[ctypes.c_int,*([ctypes.c_ulong]*4)];libc.prctl.restype=ctypes.c_int
        if expected<1 or os.getppid()!=expected or libc.prctl(1,signal.SIGTERM,0,0,0)!=0 or os.getppid()!=expected:
            raise ValueError('supervisor_parent_changed')
    genesis=check_file(value['genesis'],value['genesis_sha256']);check_file(value['verifier_binary'],value['verifier_sha256'])
    if parse(genesis.read_bytes(),4*1024*1024).get('chain_id')!=value['network']:raise ValueError('genesis_network_mismatch')
    private=check_file(value['node_key'])
    if private.stat().st_mode & 0o077:raise ValueError('node_identity_requires_private_permissions')
    key=load_identity(private);identity=node_id(key.public_key().public_bytes_raw())
    if value['peers'].get(identity)!={'public_key':key.public_key().public_bytes_raw().hex(),'endpoint':value['public_endpoint']}:raise ValueError('own_operator_identity_not_provisioned')
    state=Path(value['state_directory'])
    for parent in (state,*state.parents):
        if parent.is_symlink():raise ValueError('state_links_forbidden')
    if not state.exists():state.mkdir(mode=0o700)
    if not state.is_dir() or state.stat().st_mode & 0o077:raise ValueError('dedicated_private_point_state_required')
    if (state/'RESTORE_REQUIRES_CHECKPOINT_VALIDATION.json').exists():raise ValueError('restored_point_requires_independent_checkpoint_validation')
    with point_lock(state):return run_locked(value,genesis,key,identity,state)


def run_locked(value,genesis,key,identity,state):
    context={'domain':'sphere-mesh-point-state-v1','node':identity,'network':value['network'],'genesis':value['genesis_sha256']}
    if value.get('health_observer',False):context['health_observer']=True
    if value.get('replication_worker',False):context['replication_worker']=True
    if 'controllers' in value:context['controllers_sha256']=hashlib.sha256(canonical(value['controllers'])).hexdigest()
    if 'assessment_service' in value:context['assessment_sha256']=assessment_binding(value['assessment_service'])
    if value.get('follow_network_peers'):context['follow_network_peers']=True
    if 'point_registration' in value:context['network_ca_sha256']=value['point_registration']['ca_sha256']
    if 'enrollment_service' in value:context['enrollment_sha256']=enrollment_binding(value['enrollment_service'])
    context_path=state/'point-context.json'
    if context_path.exists():
        if context_path.is_symlink() or parse(context_path.read_bytes())!=context:raise ValueError('point_state_context_changed')
        if 'enrollment_service' in value:
            journal=state/'enrollment.sqlite'
            if journal.is_symlink() or not journal.is_file() or journal.stat().st_size==0:raise ValueError('enrollment_state_missing_recovery_required')
        if 'controllers' in value:
            for name in database_names(value['controllers']):
                path=state/name
                if not path.is_file() or path.is_symlink() or path.stat().st_size==0:raise ValueError('controller_state_missing_recovery_required')
    else:
        if any(path.name!='point.lock' for path in state.iterdir()):raise ValueError('unrelated_point_state_directory')
        with context_path.open('xb') as output:output.write(canonical(context));output.flush();os.fsync(output.fileno())
    if any(path.is_symlink() for path in state.iterdir()):raise ValueError('state_links_forbidden')
    stopped=threading.Event()
    for name in (signal.SIGINT,signal.SIGTERM):signal.signal(name,lambda *_:stopped.set())
    with ExitStack() as resources:
        roster={peer:bytes.fromhex(entry['public_key']) for peer,entry in value['peers'].items()}
        verifier=EnvelopeVerifier(value['network'],identity,roster,str(state/'replays.sqlite'));resources.callback(verifier.close)
        transport=ConfiguredHttpsTransport({peer:entry['endpoint'] for peer,entry in value['peers'].items()})
        verifier.secure_transport=transport
        health_journal=health_monitor=None
        if value.get('health_observer',False):
            health_journal=HealthJournal(str(state/'health.sqlite'),key,verifier,{peer:entry['endpoint'] for peer,entry in value['peers'].items() if peer!=identity})
            resources.callback(health_journal.close)
        store=BlobStore(str(state/'blobs.sqlite'),max_bytes=value['max_blob_bytes']);resources.callback(store.close)
        directory=ConsensusDirectory(str(state/'directory.sqlite'),value['verifier_binary'],genesis);resources.callback(directory.close)
        enrollment=None
        if 'enrollment_service' in value:
            enrollment=provision_enrollment(value['enrollment_service'],directory,str(state/'enrollment.sqlite'),check_file)
            resources.callback(enrollment.close)
        if value.get('controllers',{}).get('discovery',False) or value.get('assessment_service',{}).get('discovery',False):
            verifier.secure_transport=DiscoveredHttpsTransport({peer:entry['endpoint'] for peer,entry in value['peers'].items()},directory,roster)
        auth=MeshAuth(str(state/'auth.sqlite'),key,directory);resources.callback(auth.close)
        capacity_assessor=failure_observer=None
        if 'assessment_service' in value:
            policy=value['assessment_service'];assessor_file=check_file(policy['assessor_key'],policy['assessor_sha256'])
            if assessor_file.stat().st_mode&0o077:raise ValueError('assessment_key_requires_private_permissions')
            capacity_assessor,failure_observer=provision_assessment(policy,directory,key,verifier,value['peers'],health_journal,load_identity(assessor_file))
        sources=consensus_sources(value)
        updater=ConsensusUpdater(directory,sources).start();resources.callback(updater.stop)
        registration=None;network_admitted=not value.get('follow_network_peers',False)
        if 'point_registration' in value:
            policy=value['point_registration'];check_file(policy['ca_certificate'],policy['ca_sha256'])
            registration=PointRegistration(key,directory,sources,policy,value['listen_port'],value['tls_certificate'],value['tls_private_key'])
            resources.callback(registration.stop)
        replica_worker=None
        if value.get('replication_worker',False):
            replica_worker=VerifiedReplicaWorker(str(state/'replica.sqlite'),key,directory,sources,str(state/'replica-replays.sqlite'))
        controllers=None
        if 'controllers' in value:
            controllers=ControllerRuntime(state,directory,sources[0],key,verifier,value['peers'],value['controllers'],store=store)
            resources.callback(controllers.close)
        server=TLSMeshServer((value['listen_host'],value['listen_port']),key,verifier,store,
            certificate=value['tls_certificate'],private_key=value['tls_private_key'],directory=directory,auth=auth,
            placement_signer=PlacementSigner(key,directory),capacity_sampler=CapacitySampler(state,budget=store),manifest_queue=controllers.manifest_queue if controllers else None,
            capacity_assessor=capacity_assessor,failure_observer=failure_observer,
            consensus_gateway=ConsensusGateway(value['consensus_rpc'][0]) if value.get('serve_consensus') else None,point_enrollment=enrollment,
            readiness=lambda:updater.status()['ready'] and network_admitted and (registration is None or registration.status()['ready']) and (replica_worker is None or replica_worker.status()['initialized'] and replica_worker.status()['running']) and (controllers is None or controllers.status()['running']),max_connections=value['max_connections'])
        resources.callback(server.server_close)
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        try:
            if replica_worker is not None:replica_worker.start();resources.callback(replica_worker.stop)
            if health_journal is not None:
                health_monitor=HealthMonitor(health_journal).start();resources.callback(health_monitor.stop)
            if controllers is not None:controllers.start()
            if registration is not None:registration.server=server;registration.start()
            while not stopped.is_set():
                if value.get('follow_network_peers'):
                    try:
                        approved=approved_network_peers(directory);verifier.roster=approved
                        network_admitted=approved.get(identity)==key.public_key().public_bytes_raw()
                    except ValueError:verifier.roster={};network_admitted=False
                status={'domain':'sphere-mesh-point-status-v1','node':identity,'tls_listener_running':worker.is_alive(),
                    'consensus_snapshot_ready':updater.status()['ready'],'ui_enabled':False,
                    'process_id':os.getpid(),'runtime_nonce':os.environ.get('SPHERE_RUNTIME_NONCE')}
                status['consensus_source']='network' if value.get('consensus_gateways') else 'local-validator'
                if registration is not None:status['point_registration']=registration.status()
                if health_monitor is not None:
                    status['health_observer']={'running':health_monitor.thread.is_alive(),'error':health_monitor.error,
                        'peers':{peer:health_journal.status(peer)['state'] for peer in health_journal.endpoints},'replacement_authorised':False}
                if replica_worker is not None:status['replication_worker']=replica_worker.status()
                if controllers is not None:status['controllers']=controllers.status()
                descriptor,temporary=tempfile.mkstemp(prefix='status-',dir=state)
                with os.fdopen(descriptor,'wb') as output:output.write(canonical(status));output.flush();os.fsync(output.fileno())
                os.replace(temporary,state/'status.json')
                if not worker.is_alive() or (health_monitor is not None and not health_monitor.thread.is_alive()) or (replica_worker is not None and not replica_worker.thread.is_alive()):return 1
                if controllers is not None and not controllers.status()['running']:return 1
                if registration is not None and not registration.status()['running']:return 1
                stopped.wait(5)
        finally:
            try:
                if registration is not None:registration.stop()
                if controllers is not None:controllers.stop()
            finally:server.shutdown();server.server_close();worker.join(timeout=5);server.drain(timeout=30)
    return 0


def main():
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='command',required=True)
    start=sub.add_parser('run');start.add_argument('--config',required=True)
    check=sub.add_parser('check-config');check.add_argument('--config',required=True)
    verify=sub.add_parser('preflight');verify.add_argument('--config',required=True)
    create=sub.add_parser('init-identity');create.add_argument('--output',required=True)
    args=parser.parse_args()
    if args.command=='init-identity':
        key=create_identity(args.output);print(canonical({'node_id':node_id(key.public_key().public_bytes_raw()),'public_key':key.public_key().public_bytes_raw().hex(),'admitted':False}).decode());return 0
    value=validate_config(parse(Path(args.config).read_bytes()))
    if args.command=='check-config':print('Configuration schema verified. No network, pin-file verification, admission or service startup performed.');return 0
    if args.command=='preflight':print(canonical(preflight(value)).decode());return 0
    return run(value)


if __name__=='__main__':raise SystemExit(main())
