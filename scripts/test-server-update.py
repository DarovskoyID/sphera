"""Signed-source handoff tests with owned disposable child processes only."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import time
import unittest
from unittest.mock import patch
from release_v1 import canonical
from server_release import pack
from server_install import prepare,verify
from server_update import Supervisor,read_json

ReleaseFixture=runpy.run_path(str(Path(__file__).with_name('test-server-release.py')))['ServerReleaseTests']
ConfigFixture=runpy.run_path(str(Path(__file__).with_name('test-mesh-point-config.py')))['PointConfigTests']

CHILD=b'''import json,os,signal,sys,time
from pathlib import Path
if sys.argv[1]=='check-config':raise SystemExit(0)
config=json.loads(Path(sys.argv[-1]).read_bytes());state=Path(config['state_directory']);state.mkdir(mode=0o700,exist_ok=True)
for name in ('point-context.json','replays.sqlite','blobs.sqlite','directory.sqlite','auth.sqlite'):
 if not (state/name).exists():(state/name).write_bytes(b'owned disposable state fixture')
if config.get('health_observer') and not (state/'health.sqlite').exists():(state/'health.sqlite').write_bytes(b'owned health fixture')
if config.get('replication_worker'):
 for name in ('replica.sqlite','replica-replays.sqlite'):
  if not (state/name).exists():(state/name).write_bytes(b'owned replication fixture')
counter=state/'counter.json';counter.write_text(json.dumps({'count':(json.loads(counter.read_text())['count'] if counter.exists() else 0)+1}))
running=True
def stop(*_):
 global running
 running=False
signal.signal(signal.SIGTERM,stop)
while running:
 (state/'status.json').write_text(json.dumps({'process_id':os.getpid(),'runtime_nonce':os.environ.get('SPHERE_RUNTIME_NONCE'),'consensus_snapshot_ready':True,'tls_listener_running':True}))
 time.sleep(.02)
'''


@unittest.skipUnless(sys.platform=='linux','Owned Linux process handoff')
class UpdateTests(unittest.TestCase):
    setUpClass=classmethod(ReleaseFixture.setUpClass.__func__)
    bundle=ReleaseFixture.bundle

    def setUp(self,release_setup=ReleaseFixture.setUp,config_fixture=ConfigFixture):
        release_setup(self)
        for name,data in {'scripts/mesh_point.py':CHILD,'scripts/server_state.py':b'# pinned state lock\n','scripts/release_v1.py':b'# pinned parser\n'}.items():
            (self.source/name).write_bytes(data)
        self.envdir=self.base/'environment';binary=self.envdir/'venv/bin/python';binary.parent.mkdir(parents=True);shutil.copy2(sys.executable,binary)
        # Portable Python builds may have a non-installed compile-time prefix.
        # Give the disposable copy the real stdlib location, as a venv does.
        (self.envdir/'venv/pyvenv.cfg').write_text('home = '+str(Path(sys._base_executable).parent)+'\ninclude-system-site-packages = false\n')
        packages=self.envdir/'venv/lib'/('python'+str(sys.version_info.major)+'.'+str(sys.version_info.minor))/'site-packages'
        packages.mkdir(parents=True)
        for package in ('cryptography','cffi','pycparser'):
            spec=importlib.util.find_spec(package)
            if spec is not None:shutil.copytree(Path(spec.origin).parent,packages/package,ignore=shutil.ignore_patterns('__pycache__'))
        spec=importlib.util.find_spec('_cffi_backend')
        if spec is not None:
            backend=Path(spec.origin);shutil.copy2(backend,packages/backend.name)
        self.pin='a'*64
        (self.envdir/'environment-ready.json').write_bytes(canonical({'domain':'sphere-headless-environment-v1','wheel_lock_sha256':self.pin,'python':str(binary),'service_started':False}))
        value=config_fixture().fixture();value['state_directory']=str(self.base/'point-state')
        for field in ('node_key','genesis','verifier_binary','tls_certificate','tls_private_key'):
            path=self.base/field;path.write_bytes(b'temporary-test-input');value[field]=str(path)
        self.config=self.base/'point.json';self.config.write_bytes(canonical(value));self.operations=self.base/'operations';self.operations.mkdir(mode=0o700)
        self.versions=self.base/'versions';self.versions.mkdir()
        ready=patch('server_update.check',return_value={'ready':True,'elapsed_ms':0});ready.start();self.addCleanup(ready.stop)

    def release(self,sequence):
        (self.source/'scripts/server_tools.py').write_bytes(('# operator tools version '+str(sequence)).encode())
        archive=self.base/('release-'+str(sequence)+'.tar.gz');pack(self.source,archive);bundle=self.bundle(archive,sequence=sequence)
        manifest_path=self.base/('release-'+str(sequence)+'.json');manifest_path.write_bytes(canonical(bundle))
        result=prepare(self.versions,bundle,archive,self.trust,1)
        return {'version':result['version_directory'],'manifest':str(manifest_path),'archive':str(archive),'environment':str(self.envdir),'lock_sha256':self.pin}

    def controller(self):return Supervisor(self.operations,self.trust,self.config,1,health_timeout=3)

    def test_success_preserves_data_and_restart_keeps_floor(self):
        first=self.release(1);second=self.release(2)
        with self.controller() as supervisor:
            supervisor.start(first);old_pid=supervisor.process.pid
            self.assertTrue(supervisor.activate(second)['activated']);self.assertNotEqual(supervisor.process.pid,old_pid)
            self.assertEqual(read_json(self.base/'point-state/counter.json')['count'],2)
            with self.assertRaises(ValueError):supervisor.activate(first)
        with self.controller() as supervisor:
            result=supervisor.start(first);self.assertEqual(result['sequence'],2);self.assertEqual(result['floor'],2)

    def test_failed_new_health_recovers_code_without_restoring_state(self):
        first=self.release(1);second=self.release(2)
        with self.controller() as supervisor:
            supervisor.start(first);healthy=supervisor.healthy;calls=[]
            def fail_new_once():
                actual=healthy();calls.append(actual)
                return False if len(calls)==1 else actual
            with patch.object(supervisor,'healthy',side_effect=fail_new_once):result=supervisor.activate(second)
            self.assertFalse(result['activated']);self.assertTrue(result['ready']);self.assertFalse(result['data_restored'])
            self.assertEqual(read_json(self.base/'point-state/counter.json')['count'],3)
            self.assertEqual(supervisor.journal['floor'],2);self.assertEqual(supervisor.current['sequence'],1)
            with self.assertRaises(ValueError):supervisor.activate(second)

    def test_runtime_change_signature_tamper_and_input_change_leave_process_running(self):
        first=self.release(1)
        with self.controller() as supervisor:
            supervisor.start(first);pid=supervisor.process.pid
            (self.source/'scripts/server_state.py').write_bytes(b'# migration required\n');second=self.release(2)
            with self.assertRaisesRegex(ValueError,'runtime_changed'):supervisor.activate(second)
            self.assertEqual(supervisor.process.pid,pid);self.assertIsNone(supervisor.process.poll());self.assertEqual(supervisor.journal['floor'],1)
            Path(second['archive']).write_bytes(b'tampered')
            with self.assertRaises(ValueError):supervisor.activate(second)
            Path(self.base/'tls_private_key').write_bytes(b'operator changed TLS input')
            with self.assertRaisesRegex(ValueError,'operator_inputs_changed'):supervisor.activate(second)
            self.assertEqual(supervisor.process.pid,pid)

    def test_expired_installed_release_restarts_but_fresh_admission_is_refused(self):
        first=self.release(1)
        with self.controller() as supervisor:supervisor.start(first)
        future=int(time.time())+4000
        with patch('time.time',return_value=future):
            with self.controller() as supervisor:self.assertTrue(supervisor.start(first)['ready'])
            other=self.base/'new-operations';other.mkdir(mode=0o700)
            with Supervisor(other,self.trust,self.config,1,health_timeout=3) as supervisor:
                with self.assertRaises(ValueError):supervisor.start(first)

    def test_mutated_installed_source_and_environment_block_restart(self):
        first=self.release(1)
        with self.controller() as supervisor:supervisor.start(first)
        target=Path(first['version'])/'scripts/mesh_point.py';original=target.read_bytes();target.write_bytes(b'tamper')
        with self.controller() as supervisor:
            with self.assertRaises(ValueError):supervisor.start(first)
        target.write_bytes(original);(self.envdir/'injected.py').write_bytes(b'tamper')
        with self.controller() as supervisor:
            with self.assertRaises(ValueError):supervisor.start(first)
        (self.envdir/'injected.py').unlink();cache=self.envdir/'__pycache__';cache.mkdir();(cache/'injected.pyc').write_bytes(b'compiled code tamper')
        with self.controller() as supervisor:
            with self.assertRaises(ValueError):supervisor.start(first)

    def test_state_policy_and_concurrent_supervisor_refused(self):
        first=self.release(1)
        with self.controller() as supervisor:
            supervisor.start(first)
            with self.assertRaises(ValueError):
                with self.controller():pass
        value=read_json(self.operations/'update.json');value['policy']='b'*64;(self.operations/'update.json').write_bytes(canonical(value))
        with self.controller() as supervisor:
            with self.assertRaises(ValueError):supervisor.start(first)

    def test_stale_readiness_from_another_process_cannot_commit_release(self):
        first=self.release(1)
        with self.controller() as supervisor:
            def stale_spawn(*_):
                supervisor.nonce='fresh-start-nonce'
                supervisor.process=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])
                state=self.base/'point-state';state.mkdir(mode=0o700)
                (state/'status.json').write_bytes(canonical({'process_id':supervisor.process.pid,'runtime_nonce':'previous-process-nonce'}))
            with patch.object(supervisor,'spawn',side_effect=stale_spawn):
                with self.assertRaisesRegex(ValueError,'failed_readiness'):supervisor.start(first)
            self.assertIsNone(supervisor.process)
            self.assertEqual(supervisor.journal['phase'],'start_failed')

    def test_interrupted_request_requires_review_before_start(self):
        (self.operations/'processing.json').write_bytes(b'{}')
        with self.assertRaisesRegex(ValueError,'interrupted_request'):
            with self.controller():pass

    def test_missing_state_is_not_silently_recreated_on_restart(self):
        first=self.release(1)
        with self.controller() as supervisor:supervisor.start(first)
        database=self.base/'point-state/replays.sqlite';database.unlink()
        with self.controller() as supervisor:
            with self.assertRaisesRegex(ValueError,'state_missing'):supervisor.start(first)
            self.assertIsNone(supervisor.process)
        self.assertFalse(database.exists())

    def test_first_admission_refuses_existing_unrecorded_state(self):
        first=self.release(1);state=self.base/'point-state';state.mkdir(mode=0o700);sentinel=state/'existing-database';sentinel.write_bytes(b'do not migrate silently')
        with self.controller() as supervisor:
            with self.assertRaisesRegex(ValueError,'cannot_adopt_unrecorded_state'):supervisor.start(first)
        self.assertFalse((self.operations/'update.json').exists());self.assertEqual(sentinel.read_bytes(),b'do not migrate silently')

    def test_enabled_health_database_is_required_after_admission(self):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from sfera_mesh.identity import node_id
        value=read_json(self.config);public=Ed25519PrivateKey.generate().public_key().public_bytes_raw()
        value['peers'][node_id(public)]={'public_key':public.hex(),'endpoint':'https://extra-peer.example'}
        value['health_observer']=True;self.config.write_bytes(canonical(value));first=self.release(1)
        with self.controller() as supervisor:supervisor.start(first)
        health=self.base/'point-state/health.sqlite';health.unlink()
        with self.controller() as supervisor:
            with self.assertRaisesRegex(ValueError,'state_missing'):supervisor.start(first)
        self.assertFalse(health.exists())

    def test_enabled_replication_replays_are_not_recreated(self):
        value=read_json(self.config);value['replication_worker']=True;self.config.write_bytes(canonical(value));first=self.release(1)
        with self.controller() as supervisor:supervisor.start(first)
        replays=self.base/'point-state/replica-replays.sqlite';replays.unlink()
        with self.controller() as supervisor:
            with self.assertRaisesRegex(ValueError,'state_missing'):supervisor.start(first)
        self.assertFalse(replays.exists())

    def sqlite_source(self):
        source=CHILD.replace(b'import json,os,signal,sys,time',b'import json,os,signal,sys,time,sqlite3')
        source=source.replace(b"(state/name).write_bytes(b'owned disposable state fixture')",b"(state/name).write_text('{}') if name.endswith('.json') else sqlite3.connect(state/name).execute('CREATE TABLE records(token TEXT, revoked INTEGER)').connection.close()")
        (self.source/'scripts/mesh_point.py').write_bytes(source)
        return source

    def transition(self,supervisor,candidate,operations):
        from release_v1 import sign
        from server_schema import snapshot,projected,digest
        from server_transition import binding
        new=supervisor.admitted(candidate)[0];old=supervisor.current;now=int(time.time());before=snapshot(self.base/'point-state')
        packet={'certificate':read_json(candidate['manifest'])['certificate'],'document':sign({
            'domain':'sphere-server-transition-v1','product':'sphere','channel':'stable','issued_at':now,'expires_at':now+300,
            'from_release':binding(old),'to_release':binding(new),'before_schema_sha256':digest(before),
            'after_schema_sha256':digest(projected(before,operations)),'operations':operations,'compatibility':'sqlite-additive-backward-v1'},self.signer)}
        path=self.base/'transition.json';path.write_bytes(canonical(packet));return {**candidate,'transition':str(path)}

    def test_changed_runtime_environment_and_additive_schema_survive_restart(self):
        import sqlite3
        source=self.sqlite_source();first=self.release(1)
        with self.controller() as supervisor:
            supervisor.start(first)
            # Actual behavior change: new code writes to its explicitly migrated table.
            changed=source.replace(b'running=True',b"db=sqlite3.connect(state/'auth.sqlite');db.execute(\"INSERT INTO release_events VALUES('v2')\");db.commit();db.close()\nrunning=True")
            (self.source/'scripts/mesh_point.py').write_bytes(changed);second=self.release(2)
            other=self.base/'new-environment';shutil.copytree(self.envdir,other)
            receipt=read_json(other/'environment-ready.json');receipt['python']=str(other/'venv/bin/python');(other/'environment-ready.json').write_bytes(canonical(receipt));second['environment']=str(other)
            operations=[{'database':'auth.sqlite','table':'release_events','columns':[{'name':'version','type':'TEXT'}]}]
            second=self.transition(supervisor,second,operations)
            self.assertTrue(supervisor.activate(second)['activated'])
            db=sqlite3.connect(self.base/'point-state/auth.sqlite')
            try:self.assertEqual(db.execute('SELECT version FROM release_events').fetchall(),[('v2',)])
            finally:db.close()
        with self.controller() as supervisor:self.assertEqual(supervisor.start(first)['sequence'],2)

    def test_failed_changed_runtime_retains_revocation_and_additive_table(self):
        import sqlite3
        source=self.sqlite_source();first=self.release(1)
        with self.controller() as supervisor:
            supervisor.start(first)
            changed=source.replace(b'running=True',b"db=sqlite3.connect(state/'auth.sqlite');db.execute(\"INSERT INTO records VALUES('revoked-during-failed-update',1)\");db.commit();db.close()\nrunning=True")
            (self.source/'scripts/mesh_point.py').write_bytes(changed);second=self.release(2)
            second=self.transition(supervisor,second,[{'database':'auth.sqlite','table':'release_events','columns':[{'name':'version','type':'TEXT'}]}])
            healthy=supervisor.healthy;calls=[]
            def fail_once():
                actual=healthy();calls.append(actual);return False if len(calls)==1 else actual
            with patch.object(supervisor,'healthy',side_effect=fail_once):result=supervisor.activate(second)
            self.assertFalse(result['activated']);self.assertTrue(result['ready']);self.assertEqual(result['floor'],2)
            db=sqlite3.connect(self.base/'point-state/auth.sqlite')
            try:
                self.assertEqual(db.execute('SELECT revoked FROM records').fetchall(),[(1,)])
                self.assertEqual(db.execute('SELECT * FROM release_events').fetchall(),[])
            finally:db.close()
        with self.controller() as supervisor:self.assertEqual(supervisor.start(first)['sequence'],1)

    def test_transition_tamper_or_environment_change_refused_before_stop(self):
        source=self.sqlite_source();first=self.release(1)
        with self.controller() as supervisor:
            supervisor.start(first);pid=supervisor.process.pid
            (self.source/'scripts/mesh_point.py').write_bytes(source+b'\n# changed source\n');second=self.release(2)
            second=self.transition(supervisor,second,[])
            Path(second['transition']).write_bytes(b'{}')
            with self.assertRaises(ValueError):supervisor.activate(second)
            self.assertEqual(supervisor.process.pid,pid);self.assertEqual(supervisor.journal['floor'],1)
            second=self.transition(supervisor,second,[])
            packet=read_json(second['transition']);packet['document']['signature']='A'*512
            Path(second['transition']).write_bytes(canonical(packet))
            with self.assertRaisesRegex(ValueError,'signature_invalid'):supervisor.activate(second)
            self.assertEqual(supervisor.process.pid,pid)
            second=self.transition(supervisor,second,[])
            (self.envdir/'unexpected.py').write_bytes(b'# environment mutation')
            with self.assertRaises(ValueError):supervisor.activate(second)
            self.assertEqual(supervisor.process.pid,pid);self.assertEqual(supervisor.journal['floor'],1)

    def test_interrupted_atomic_migration_recovers_actual_schema_without_reapply(self):
        from server_schema import snapshot,projected,migrate
        self.sqlite_source();first=self.release(1)
        with self.controller() as supervisor:
            supervisor.start(first);supervisor.stop()
            before=snapshot(self.base/'point-state');operations=[{'database':'auth.sqlite','table':'release_events','columns':[{'name':'version','type':'TEXT'}]}]
            after=projected(before,operations)
            supervisor.journal.update(floor=2,phase='migrating',migration={'before':before,'after':after})
            supervisor.write('update.json',supervisor.journal)
            migrate(self.base/'point-state',before,operations)
        with self.controller() as supervisor:
            self.assertEqual(supervisor.start(first)['sequence'],1);self.assertEqual(supervisor.journal['floor'],2)
            self.assertEqual(supervisor.journal['schema'],after);self.assertNotIn('migration',supervisor.journal)

    def test_publisher_portable_update_checks_schema_and_keeps_environment(self):
        from release_v1 import sign
        from server_transition import portable_binding
        from server_schema import snapshot,digest
        source=self.sqlite_source();first=self.release(1)
        with self.controller() as supervisor:
            supervisor.start(first);pid=supervisor.process.pid
            (self.source/'scripts/mesh_point.py').write_bytes(source+b'\n# compatible new release\n');second=self.release(2);record=supervisor.admitted(second)[0]
            body={'domain':'sphere-server-transition-preserve-v1','product':'sphere','channel':'stable','issued_at':int(time.time()),'expires_at':int(time.time())+300,
                'from_release':portable_binding(supervisor.current),'to_release':portable_binding(record),'allowed_schemas':['a'*64],'compatibility':'sqlite-preserve-backward-v1'}
            path=self.base/'portable.json';packet={'certificate':read_json(second['manifest'])['certificate'],'document':sign(body,self.signer)};path.write_bytes(canonical(packet));second['transition']=str(path)
            with self.assertRaisesRegex(ValueError,'schema'):supervisor.activate(second)
            self.assertEqual(supervisor.process.pid,pid)
            body['allowed_schemas']=[digest(snapshot(self.base/'point-state'))];packet['document']=sign(body,self.signer);path.write_bytes(canonical(packet))
            self.assertTrue(supervisor.activate(second)['activated']);self.assertEqual(supervisor.journal['floor'],2)


del ReleaseFixture,ConfigFixture
if __name__=='__main__':unittest.main()
