"""Signed-job preflight: disposable Linux tests; no installed service changes."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import zipfile


def main():
    settings=Path('/opt/sphere-point/code/preparing.json')
    if not settings.exists():settings=Path('/opt/sphere-point/code/pending.json')
    current=json.loads(settings.read_bytes());installed=Path(current['version'])
    sys.path[:0]=[str(installed/'scripts'),str(installed/'django-server/sfera_server')]
    from server_release import archive_members
    point=json.loads(Path('/opt/sphere-point/data/point.json').read_bytes())
    with zipfile.ZipFile(sys.argv[0]) as package,tempfile.TemporaryDirectory(prefix='sphere-registration-preflight-') as folder:
        job=json.loads(package.read('job.json'));root=Path(folder)
        if point['network']!=job['network']:raise ValueError('preflight_network_mismatch')
        raw=package.read('source.tar.gz')
        if hashlib.sha256(raw).hexdigest()!=job['source_sha256']:raise ValueError('preflight_source_digest')
        archive=root/'source.tar.gz';archive.write_bytes(raw);archive_members(archive)
        source=root/'source';source.mkdir(mode=0o700)
        with tarfile.open(archive,'r:gz') as stream:
            for member in stream:
                target=source/member.name;target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes(stream.extractfile(member).read())
        for name in job['tests']:
            if name not in ('test-server-verifier-transition.py','test-server-update.py','test-server-release.py','test-mesh-point-config.py'):
                raise ValueError('preflight_test_path')
            (source/'scripts'/name).write_bytes(package.read('tests/'+name))
        import os
        env={**os.environ,'PYTHONPATH':str(source/'scripts')+':'+str(source/'django-server/sfera_server')}
        result=subprocess.run([sys.executable,'-B',str(source/'scripts/test-server-verifier-transition.py')],cwd=source,env=env)
        if result.returncode:raise ValueError('linux_verifier_handoff_tests_failed')
    journal=json.loads(Path('/opt/sphere-point/data/operations/update.json').read_bytes())
    units=subprocess.run(['systemctl','list-units','--all','--plain','--no-legend','--no-pager','sphere*'],capture_output=True,text=True,check=True)
    print(json.dumps({'linux_disposable_handoff_tests_passed':True,'installed_services_changed':False,
        'network':point['network'],'genesis':point['genesis_sha256'],'verifier_sha256':point['verifier_sha256'],
        'verifier_binary':point['verifier_binary'],'release_sequence':journal['active']['sequence'],
        'release_floor':journal['floor'],'services':units.stdout.splitlines()},ensure_ascii=True),flush=True)


if __name__=='__main__':main()
