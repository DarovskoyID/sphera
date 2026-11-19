"""Consumer bootstrap build/check and publisher-profile validation, no services."""
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import time
import unittest
from release_v1 import canonical,sign,key_id
from server_point_bundle import bundle
from server_point_install import network_profile
from server_point_install import prepared_version,asset
from unittest.mock import patch
import hashlib

Fixture=runpy.run_path(str(Path(__file__).with_name('test-server-release.py')))['ServerReleaseTests']


class PointInstallerTests(unittest.TestCase):
    def test_ordinary_python_bootstrap_requires_signed_github_plan(self):
        from server_point_bootstrap import approved
        from server_release import pack
        archive=self.base/'bootstrap-fixture.tar.gz';pack(self.fixture.source,archive);certificate=self.fixture.bundle(archive)['certificate'];now=int(time.time())
        meta={'url':'https://github.com/owner/repo/releases/download/v1/asset','size':1,'sha256':'0'*64}
        body={'domain':'sphere-point-bootstrap-v1','product':'sphere','channel':'stable','issued_at':now-1,'expires_at':now+200,'python':dict(meta),'wheels':{n+'.whl':dict(meta) for n in ('cryptography','cffi','pycparser')},'network_profile':dict(meta)}
        packet={'certificate':certificate,'document':sign(body,self.fixture.signer)};self.assertEqual(approved(packet,self.trust),body)
        changed={**body,'python':{**meta,'url':'https://untrusted.example/python'}}
        with self.assertRaises(ValueError):approved({'certificate':certificate,'document':sign(changed,self.fixture.signer)},self.trust)
        with self.assertRaises(ValueError):approved({'certificate':certificate,'document':sign({**body,'expires_at':now-1},self.fixture.signer)},self.trust)
        with self.assertRaises(ValueError):approved({},self.trust)

    @classmethod
    def setUpClass(cls,fixture_type=Fixture):fixture_type.setUpClass();cls.fixture_type=fixture_type
    def setUp(self):
        self.fixture=self.fixture_type();self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.base=self.fixture.base;self.trust={**self.fixture.trust,'domain':'sphere-release-trust-v1','product':'sphere','root_key_id':key_id(self.fixture.public),'base_url':'https://github.com/owner/repo/releases/latest/download/'}
    def test_generated_consumer_bootstrap_embeds_trust_and_requires_no_roles(self):
        trust=self.base/'trust.json';trust.write_bytes(canonical(self.trust));destination=self.base/'bootstrap'
        result=bundle(Path(__file__).resolve().parents[1],trust,destination,'https://seed.example/network-profile.json','https://seed.example/sphere-install.pyz')
        checked=subprocess.run([sys.executable,'-I','-B',str(destination/'sphere-install.pyz'),'--check'],capture_output=True,text=True)
        self.assertEqual(checked.returncode,0,checked.stderr);self.assertIn('"user_validator_configuration_required":false',checked.stdout);self.assertEqual(result['commands'],2)
        self.assertIn(result['installer_sha256'],(destination/'sphere-install.sh').read_text())
    def test_unapproved_profile_or_self_assigned_role_never_accepted(self):
        with self.assertRaises(ValueError):network_profile({},self.trust)
        archive=self.base/'fixture.tar.gz'
        from server_release import pack
        pack(self.fixture.source,archive);certificate=self.fixture.bundle(archive)['certificate'];now=int(time.time())
        body={'domain':'sphere-point-network-v1','product':'sphere','channel':'stable','sequence':1,'issued_at':now,'expires_at':now+300,'role':'validator'}
        with self.assertRaises(ValueError):network_profile({'certificate':certificate,'document':sign(body,self.fixture.signer)},self.trust)

    def test_interrupted_source_stage_resumes_without_deleting_partial_files(self):
        from server_release import pack
        archive=self.base/'source.tar.gz';pack(self.fixture.source,archive);packet=self.fixture.bundle(archive)
        versions=self.base/'versions';versions.mkdir();partial=versions/('release-2-'+hashlib.sha256(archive.read_bytes()).hexdigest());partial.mkdir();(partial/'diagnostic').write_bytes(b'preserved incomplete source')
        completed=prepared_version(versions,packet,archive,self.trust,2)
        self.assertTrue((completed/'verified-server-release.json').exists());quarantine=list(versions.glob('incomplete-*'));self.assertEqual(len(quarantine),1)
        self.assertEqual((quarantine[0]/'diagnostic').read_bytes(),b'preserved incomplete source')
        (completed/'injected.py').write_bytes(b'operator modified signed code')
        with self.assertRaises(ValueError):prepared_version(versions,packet,archive,self.trust,2)
        self.assertTrue((completed/'injected.py').exists())

    def test_downloaded_assets_resume_only_with_exact_hash(self):
        data=b'verified immutable asset';meta={'url':'https://source.example/asset','size':len(data),'sha256':hashlib.sha256(data).hexdigest()};path=self.base/'asset'
        with patch('server_point_install.download',return_value=data) as fetch:
            asset(meta,path,1024);asset(meta,path,1024);self.assertEqual(fetch.call_count,1)
        path.write_bytes(b'changed existing asset')
        with self.assertRaisesRegex(ValueError,'changed'):asset(meta,path,1024)
        self.assertEqual(path.read_bytes(),b'changed existing asset')


del Fixture
if __name__=='__main__':unittest.main()
