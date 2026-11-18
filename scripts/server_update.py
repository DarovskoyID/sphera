"""Owned-process headless supervisor with signed additive migrations.

Changed runtime/environments require a publisher-signed compatibility contract.
Rollback restarts previously admitted code against current data; never restores
DBs/replay counters. A protected journal keeps the highest attempted sequence.
"""
import argparse
import hashlib
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
sys.dont_write_bytecode=True
import tempfile
import time
from release_v1 import canonical,parse,manifest
from server_release import archive_members
from server_install import directory
from server_service import command
from server_monitor import check
from server_state import point_lock


def read_json(path):
    path=Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size>1024*1024:raise ValueError('bounded_regular_update_file_required')
    return parse(path.read_bytes(),1024*1024)


def descriptor(value):
    required={'version','manifest','archive','environment','lock_sha256'}
    if not isinstance(value,dict) or set(value) not in (required,required|{'transition'}):raise ValueError('deployment_descriptor_schema')
    for field in ('version','manifest','archive','environment',*(['transition'] if 'transition' in value else [])):
        if not isinstance(value[field],str) or not Path(value[field]).is_absolute():raise ValueError('absolute_deployment_paths_required')
    if not isinstance(value['lock_sha256'],str) or len(value['lock_sha256'])!=64 or any(c not in '0123456789abcdef' for c in value['lock_sha256']):raise ValueError('approved_environment_pin_required')
    return value


def runtime_fingerprint(archive):
    files=archive_members(archive)
    required={'scripts/mesh_point.py','scripts/server_state.py','scripts/release_v1.py'}
    selected={name:entry for name,entry in files.items() if name.startswith('django-server/sfera_server/') or name in required}
    if not required<=set(selected) or not any(name.startswith('django-server/sfera_server/') for name in selected):raise ValueError('complete_point_runtime_required')
    return hashlib.sha256(canonical(selected)).hexdigest()


def input_binding(config):
    from mesh_point import validate_config,check_file
    value=validate_config(read_json(config));records={'config':hashlib.sha256(Path(config).read_bytes()).hexdigest()}
    for field in ('node_key','genesis','verifier_binary','tls_certificate','tls_private_key'):
        path=check_file(value[field])
        if field=='tls_certificate' and 'point_registration' in value:
            from cryptography import x509
            from cryptography.hazmat.primitives import serialization
            from sfera_mesh.identity import load_identity
            certificate=x509.load_pem_x509_certificate(path.read_bytes());ca=value['point_registration'];ca_path=check_file(ca['ca_certificate'],ca['ca_sha256'])
            certificate.verify_directly_issued_by(x509.load_pem_x509_certificate(ca_path.read_bytes()))
            public=load_identity(value['node_key']).public_key().public_bytes_raw()
            if certificate.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw)!=public:raise ValueError('renewed_tls_identity_changed')
            records[field]=hashlib.sha256(public).hexdigest();records['network_ca']=ca['ca_sha256']
        else:
            with path.open('rb') as source:records[field]=hashlib.file_digest(source,'sha256').hexdigest()
    if 'assessment_service' in value:
        policy=value['assessment_service'];path=check_file(policy['assessor_key'],policy['assessor_sha256'])
        records['assessor_key']=policy['assessor_sha256']
    return hashlib.sha256(canonical(records)).hexdigest(),value


def environment_fingerprint(root):
    root=directory(root);records={};total=0
    for parent,dirs,files in os.walk(root,followlinks=False):
        for name in [*dirs,*files]:
            path=Path(parent)/name;relative=path.relative_to(root).as_posix()
            if path.is_symlink():
                if not path.resolve().is_relative_to(root):raise ValueError('environment_external_link')
                records[relative]={'link':os.readlink(path)}
            elif path.is_file():
                total+=path.stat().st_size
                if total>512*1024*1024 or len(records)>20000:raise ValueError('environment_inventory_limit')
                with path.open('rb') as source:records[relative]={'sha256':hashlib.file_digest(source,'sha256').hexdigest()}
    return hashlib.sha256(canonical(records)).hexdigest()


class Supervisor:
    def __init__(self,operations,trust,config,minimum,*,context=None,health_timeout=60,recovery_public_key=None):
        self.operations=directory(operations);self.trust=trust;self.config=Path(config)
        if sys.platform!='linux' or self.operations.stat().st_mode&0o077:raise ValueError('private_linux_operations_directory_required')
        if type(minimum) is not int or minimum<1 or not 1<=health_timeout<=120:raise ValueError('supervisor_policy')
        self.minimum=minimum;self.context=context;self.timeout=health_timeout;self.process=None
        self.recovery_public_key=recovery_public_key
        self.binding,self.config_value=input_binding(self.config)
        if self.context is None and 'point_registration' in self.config_value:
            import ssl
            self.context=ssl.create_default_context(cafile=self.config_value['point_registration']['ca_certificate'])
        state=Path(self.config_value['state_directory'])
        if self.operations.is_relative_to(state) or state.is_relative_to(self.operations):raise ValueError('operations_directory_must_be_separate_from_point_state')
        self.policy=hashlib.sha256(canonical({'trust':trust,'config_binding':self.binding})).hexdigest()
        self.journal=None;self.current=None;self._lock=None

    def __enter__(self):
        self._lock=point_lock(self.operations);self._lock.__enter__()
        if (self.operations/'processing.json').exists() or (self.operations/'processing.json').is_symlink():
            self._lock.__exit__(None,None,None);raise ValueError('interrupted_request_requires_operator_review')
        if any(path.name not in {'point.lock','update.json','request.json','result.json','schema-policy.json'} for path in self.operations.iterdir()):
            self._lock.__exit__(None,None,None);raise ValueError('dedicated_update_operations_directory_required')
        return self

    def __exit__(self,*error):
        try:self.stop()
        finally:self._lock.__exit__(*error)

    def write(self,name,value):
        target=self.operations/name
        if target.is_symlink():raise ValueError('update_journal_link')
        fd,path=tempfile.mkstemp(prefix='update-',dir=self.operations)
        try:
            with os.fdopen(fd,'wb') as output:output.write(canonical(value));output.flush();os.fsync(output.fileno())
            os.replace(path,target)
            directory_fd=os.open(self.operations,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(directory_fd)
            finally:os.close(directory_fd)
        finally:
            if os.path.exists(path):os.unlink(path)

    def admitted(self,value,*,accepted_at=None,minimum=None):
        value=descriptor(value);bundle=read_json(value['manifest'])
        body=manifest(bundle,self.trust['root_public_key'],self.trust['channel'],'linux-server-source',minimum or self.minimum,now=accepted_at)
        argv,env=command(value['version'],bundle,value['archive'],self.trust,minimum or self.minimum,value['environment'],value['lock_sha256'],self.config,accepted_at=accepted_at)
        return {'deployment':value,'accepted_at':int(time.time()) if accepted_at is None else accepted_at,'sequence':body['sequence'],
            'manifest_sha256':hashlib.sha256(canonical(bundle)).hexdigest(),'runtime':runtime_fingerprint(value['archive']),
            'environment_sha256':environment_fingerprint(value['environment'])},argv,env

    def unchanged_inputs(self):
        if input_binding(self.config)[0]!=self.binding:raise ValueError('operator_inputs_changed_during_update')

    def initialized_state(self):
        state=directory(self.config_value['state_directory'])
        required=['point-context.json','replays.sqlite','blobs.sqlite','directory.sqlite','auth.sqlite']
        if self.config_value.get('health_observer',False):required.append('health.sqlite')
        if self.config_value.get('replication_worker',False):required.extend(('replica.sqlite','replica-replays.sqlite'))
        if 'controllers' in self.config_value:
            from sfera_mesh.controller_runtime import database_names
            required.extend(database_names(self.config_value['controllers']))
        for name in required:
            path=state/name
            if path.is_symlink() or not path.is_file() or path.stat().st_size==0:raise ValueError('admitted_point_state_missing_recovery_required')

    def spawn(self,argv,env):
        self.unchanged_inputs();self.nonce=secrets.token_hex(32)
        if self.journal['initialized']:self.initialized_state()
        if 'schema' in self.journal:
            from server_schema import snapshot
            state=self.config_value['state_directory']
            if snapshot(state)!=self.journal['schema']:raise ValueError('admitted_state_schema_changed')
            policy={'state':state,'databases':self.journal['schema']};self.write('schema-policy.json',policy)
            raw=canonical(policy);launcher=Path(__file__).with_name('server_schema_guard.py').resolve()
            argv=[*argv[:4],str(launcher),str(self.operations/'schema-policy.json'),hashlib.sha256(raw).hexdigest(),*argv[4:]]
        self.process=subprocess.Popen(argv,env={**env,'SPHERE_RUNTIME_NONCE':self.nonce,'SPHERE_SUPERVISOR_PID':str(os.getpid())})

    def healthy(self):
        deadline=time.monotonic()+self.timeout
        while time.monotonic()<deadline:
            if self.process.poll() is not None:return False
            try:
                status=read_json(Path(self.config_value['state_directory'])/'status.json')
                owned=(status.get('process_id')==self.process.pid and status.get('runtime_nonce')==self.nonce
                    and status.get('consensus_snapshot_ready') is True and status.get('tls_listener_running') is True)
                monitor={'context':self.context}
                if 'point_registration' in self.config_value:
                    from sfera_mesh.identity import load_identity
                    monitor.update(key=load_identity(self.config_value['node_key']),network=self.config_value['network'])
                if owned and check(self.config_value['public_endpoint'],**monitor)['ready'] and self.process.poll() is None:return True
            except (ValueError,OSError):pass
            time.sleep(.2)
        return False

    def stop(self):
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
                # Never force-kill a process writing point state.
                self.process.wait(timeout=45)
            self.process=None

    def start(self,initial):
        if self.process is not None and self.process.poll() is None:raise ValueError('owned_point_already_running')
        path=self.operations/'update.json'
        if path.exists():
            value=read_json(path)
            required={'domain','policy','floor','active','phase','initialized'}
            if not isinstance(value,dict) or not required<=set(value)<=required|{'schema','migration'} or value['domain']!='sphere-point-update-v1' or value['policy']!=self.policy or type(value['floor']) is not int or value['floor']<self.minimum or type(value['initialized']) is not bool or not isinstance(value['phase'],str) or value['phase'] not in {'initial_start','start_failed','running','prepared','warming','recovering','recovered','recovery_not_ready','migrating'}:raise ValueError('update_journal_policy_or_floor')
            if value['phase']=='migrating':
                from server_schema import snapshot
                plan=value.get('migration')
                if not isinstance(plan,dict) or set(plan)!={'before','after'}:raise ValueError('interrupted_migration_requires_schema_review')
                actual=snapshot(self.config_value['state_directory'])
                if actual not in (plan['before'],plan['after']):raise ValueError('interrupted_migration_unknown_schema')
                # SQLite committed all additions or none. Resume old compatible
                # code against actual current data, never rerun or restore DBs.
                value.update(schema=actual,phase='recovering');value.pop('migration')
                self.write('update.json',value)
            elif 'migration' in value:raise ValueError('unexpected_pending_migration')
            active=value['active']
            if not isinstance(active,dict) or set(active)!={'deployment','accepted_at','sequence','manifest_sha256','runtime','environment_sha256'} or type(active['sequence']) is not int or type(active['accepted_at']) is not int or active['sequence']>value['floor']:raise ValueError('update_journal_active_release')
            accepted,argv,env=self.admitted(active['deployment'],accepted_at=active['accepted_at'],minimum=active['sequence'])
            if accepted!=active:raise ValueError('admitted_installed_release_changed')
            self.journal=value
        else:
            accepted,argv,env=self.admitted(initial)
            state=Path(self.config_value['state_directory'])
            if state.exists() and any(directory(state).iterdir()):
                if self.recovery_public_key is None:raise ValueError('initial_supervisor_cannot_adopt_unrecorded_state')
                from server_recovery import verify_adoption
                with point_lock(state):
                    recovery=verify_adoption(self.config_value,self.recovery_public_key)
                    if self.minimum<recovery['minimum_release_sequence'] or accepted['sequence']<recovery['minimum_release_sequence']:raise ValueError('independent_recovery_release_floor')
            self.journal={'domain':'sphere-point-update-v1','policy':self.policy,'floor':accepted['sequence'],'active':accepted,'phase':'initial_start','initialized':False}
            self.write('update.json',self.journal)
        self.current=self.journal['active'];self.spawn(argv,env)
        if not self.healthy():
            self.stop();self.journal['phase']='start_failed';self.write('update.json',self.journal)
            raise ValueError('admitted_point_failed_readiness')
        self.initialized_state();self.journal.update(phase='running',initialized=True);self.write('update.json',self.journal)
        return {'sequence':self.current['sequence'],'floor':self.journal['floor'],'ready':True}

    def activate(self,candidate):
        if self.process is None or self.process.poll() is not None:raise ValueError('owned_running_point_required')
        self.unchanged_inputs()
        old,old_argv,old_env=self.admitted(self.current['deployment'],accepted_at=self.current['accepted_at'],minimum=self.current['sequence'])
        if old!=self.current:raise ValueError('installed_release_changed')
        new,argv,env=self.admitted(candidate,minimum=max(self.minimum,self.journal['floor']+1))
        changed=(new['runtime']!=old['runtime'] or new['environment_sha256']!=old['environment_sha256']
            or any(new['deployment'][field]!=old['deployment'][field] for field in ('environment','lock_sha256')))
        migration=None
        if changed or 'transition' in candidate:
            if 'transition' not in candidate:raise ValueError('runtime_changed_requires_explicit_state_migration')
            from server_schema import snapshot
            from server_transition import validate
            before=snapshot(self.config_value['state_directory'])
            operations,after=validate(read_json(candidate['transition']),self.trust,old,new,before)
            migration=(before,operations,after)
        self.journal.update(floor=new['sequence'],phase='prepared');self.write('update.json',self.journal)
        self.stop()
        if migration is not None:
            from server_schema import migrate
            before,operations,after=migration
            self.journal.update(phase='migrating',migration={'before':before,'after':after});self.write('update.json',self.journal)
            try:
                with point_lock(Path(self.config_value['state_directory'])):migrate(self.config_value['state_directory'],before,operations)
            except Exception:
                # SQLite rolls back the entire one-database migration. If schema
                # differs, spawn refuses recovery instead of resetting state.
                self.journal.pop('migration');self.journal.update(schema=before,active=old,phase='recovering');self.write('update.json',self.journal)
                self.spawn(old_argv,old_env);ready=self.healthy();self.current=old
                self.journal['phase']='recovered' if ready else 'recovery_not_ready';self.write('update.json',self.journal)
                return {'activated':False,'migration_failed':True,'ready':ready,'floor':self.journal['floor'],'data_restored':False}
            self.journal.pop('migration');self.journal['schema']=after
        self.journal.update(active=new,phase='warming');self.write('update.json',self.journal)
        try:
            self.spawn(argv,env)
            if not self.healthy():raise ValueError('new_point_failed_readiness')
            self.unchanged_inputs()
        except Exception:
            self.stop()
            self.journal.update(active=old,phase='recovering');self.write('update.json',self.journal)
            self.spawn(old_argv,old_env);ready=self.healthy()
            self.current=old;self.journal['phase']='recovered' if ready else 'recovery_not_ready';self.write('update.json',self.journal)
            return {'activated':False,'recovered_previous_code':True,'ready':ready,'floor':self.journal['floor'],'data_restored':False}
        self.current=new;self.journal['phase']='running';self.write('update.json',self.journal)
        return {'activated':True,'sequence':new['sequence'],'floor':self.journal['floor'],'data_restored':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('deployment','trust','config','operations-directory'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--minimum-sequence',required=True,type=int)
    parser.add_argument('--recovery-public-key',help='Independently trusted recovery guardian; never inferred from restored files')
    parser.add_argument('--inspect-deployment',action='store_true',help='Verify and print an admission record without starting a point')
    args=parser.parse_args()
    if args.inspect_deployment:
        controller=Supervisor(args.operations_directory,read_json(args.trust),args.config,args.minimum_sequence)
        print(canonical(controller.admitted(read_json(args.deployment))[0]).decode());return
    stopped=False
    def end(*_):
        nonlocal stopped
        stopped=True
    for name in (signal.SIGINT,signal.SIGTERM):signal.signal(name,end)
    with Supervisor(args.operations_directory,read_json(args.trust),args.config,args.minimum_sequence,recovery_public_key=args.recovery_public_key) as supervisor:
        print(canonical(supervisor.start(read_json(args.deployment))).decode(),flush=True)
        while not stopped:
            if supervisor.process is None or supervisor.process.poll() is not None:raise ValueError('owned_point_exited')
            request=supervisor.operations/'request.json'
            if request.exists() or request.is_symlink():
                processing=supervisor.operations/'processing.json'
                request.rename(processing)  # Claim this request before a new one arrives.
                try:result=supervisor.activate(read_json(processing))
                except (ValueError,OSError,subprocess.SubprocessError) as error:result={'activated':False,'error':type(error).__name__,'reason':str(error) if isinstance(error,ValueError) else 'system_operation_failed'}
                result['request_sha256']=hashlib.sha256(processing.read_bytes()).hexdigest()
                supervisor.write('result.json',result)
                processing.unlink()
                print(canonical(result).decode(),flush=True)
            time.sleep(.5)


if __name__=='__main__':main()
