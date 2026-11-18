"""Durable bounded maintenance jobs, telemetry and an idempotent HTTPS alert outbox."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import sqlite3
import ssl
import subprocess
import time
from urllib.request import build_opener,HTTPSHandler,ProxyHandler,Request
from urllib.error import HTTPError
from release_v1 import canonical,parse
from server_state import point_lock
from server_install import directory
from server_monitor import check,transition


def private_file(path):
    path=Path(path)
    if not path.is_absolute() or any(p.is_symlink() for p in (path,*path.parents)) or not path.is_file() or path.stat().st_size>1024*1024:raise ValueError('private_maintenance_file_required')
    if os.name=='posix' and path.stat().st_mode&0o077:raise ValueError('maintenance_secret_permissions')
    return path


def validate(value):
    fields={'domain','state_directory','jobs','monitor','alerts'}
    if not isinstance(value,dict) or not fields<=set(value)<=fields|{'escalation_seconds'} or value['domain']!='sphere-maintenance-v1':raise ValueError('maintenance_schema')
    if type(value.get('escalation_seconds',3600)) is not int or not 60<=value.get('escalation_seconds',3600)<=86400:raise ValueError('bounded_alert_escalation')
    if not isinstance(value['jobs'],dict) or len(value['jobs'])>16:raise ValueError('bounded_maintenance_jobs')
    for name,job in value['jobs'].items():
        if not re.fullmatch('[a-z][a-z0-9_]{0,31}',name) or not isinstance(job,dict) or set(job)!={'argv','interval','timeout'}:raise ValueError('maintenance_job_schema')
        if type(job['interval']) is not int or not 60<=job['interval']<=604800 or type(job['timeout']) is not int or not 1<=job['timeout']<=3600:raise ValueError('bounded_job_schedule')
        argv=job['argv']
        if not isinstance(argv,list) or not 1<=len(argv)<=32 or any(not isinstance(a,str) or not a or len(a)>4096 or '\0' in a for a in argv) or not Path(argv[0]).is_absolute():raise ValueError('explicit_maintenance_argv')
    monitor=value['monitor']
    if monitor is not None:
        from server_monitor import endpoint_url
        required={'endpoint','ca_certificate','failure_threshold','recovery_threshold'}
        if not isinstance(monitor,dict) or set(monitor) not in (required,required|{'node_key','node','network'}):raise ValueError('maintenance_monitor_schema')
        if 'node_key' in monitor:
            if not isinstance(monitor['node_key'],str) or not Path(monitor['node_key']).is_absolute() or not isinstance(monitor['node'],str) or not re.fullmatch('[0-9a-f]{64}',monitor['node']) or not isinstance(monitor['network'],str) or not monitor['network']:raise ValueError('maintenance_point_identity')
        endpoint_url(monitor['endpoint'])
        transition(None,monitor['endpoint'],{'ready':False},failure_threshold=monitor['failure_threshold'],recovery_threshold=monitor['recovery_threshold'])
        if monitor['ca_certificate'] is not None and not Path(monitor['ca_certificate']).is_absolute():raise ValueError('absolute_monitor_ca')
    alerts=value['alerts']
    if alerts is not None:
        from server_monitor import endpoint_url
        if not isinstance(alerts,dict) or set(alerts)!={'endpoint','ca_certificate','bearer_file'}:raise ValueError('maintenance_alert_schema')
        endpoint_url(alerts['endpoint'])
        for field in ('ca_certificate','bearer_file'):
            if alerts[field] is not None and not Path(alerts[field]).is_absolute():raise ValueError('absolute_alert_files')
    return value


def send_alert(policy,event):
    from sfera_mesh.transport import NoRedirect
    context=ssl.create_default_context(cafile=policy['ca_certificate'])
    headers={'Content-Type':'application/json','Idempotency-Key':event['id']}
    if policy['bearer_file']:
        token=private_file(policy['bearer_file']).read_text().strip()
        if not token or len(token)>4096 or any(c in token for c in '\r\n'):raise ValueError('bounded_alert_token')
        headers['Authorization']='Bearer '+token
    opener=build_opener(ProxyHandler({}),HTTPSHandler(context=context),NoRedirect())
    try:
        with opener.open(Request(policy['endpoint']+'/mesh/operations/v1/events',data=canonical(event),headers=headers,method='POST'),timeout=5) as response:
            if response.status not in (200,201,202,204) or len(response.read(1025))>1024:raise ValueError('alert_not_acknowledged')
    except HTTPError as error:error.close();raise


class Maintenance:
    def __init__(self,config):
        self.config=validate(config);self.folder=directory(config['state_directory'])

    def tick(self,*,now=None,runner=None,probe=None,sender=None):
        now=int(time.time() if now is None else now);runner=runner or self.run_job;probe=probe or self.probe;sender=sender or send_alert
        with point_lock(self.folder):
            path=self.folder/'maintenance.sqlite'
            if path.is_symlink():raise ValueError('maintenance_state_link')
            with sqlite3.connect(path) as db:
                db.execute('PRAGMA synchronous=FULL')
                db.executescript('''CREATE TABLE IF NOT EXISTS pin(id INTEGER PRIMARY KEY,policy TEXT NOT NULL);
                  CREATE TABLE IF NOT EXISTS jobs(name TEXT PRIMARY KEY,next_due INTEGER NOT NULL,status TEXT NOT NULL,failures INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL);
                  CREATE TABLE IF NOT EXISTS successes(name TEXT PRIMARY KEY,completed_at INTEGER NOT NULL);
                  CREATE TABLE IF NOT EXISTS conditions(name TEXT PRIMARY KEY,down_since INTEGER NOT NULL,last_escalation INTEGER NOT NULL,level INTEGER NOT NULL);
                  CREATE TABLE IF NOT EXISTS monitor(id INTEGER PRIMARY KEY,value BLOB NOT NULL);
                  CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,body BLOB NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_due INTEGER NOT NULL DEFAULT 0);''')
                pin=hashlib.sha256(canonical(self.config)).hexdigest();old=db.execute('SELECT policy FROM pin WHERE id=1').fetchone()
                if old and old[0]!=pin:raise ValueError('maintenance_policy_changed')
                db.execute('INSERT OR IGNORE INTO pin VALUES(1,?)',(pin,));db.commit()
                def event(body):
                    if db.execute('SELECT COUNT(*) FROM events').fetchone()[0]>=1000:raise ValueError('alert_outbox_full')
                    db.execute('INSERT INTO events(body) VALUES(?)',(canonical({**body,'timestamp':now}),))
                def condition(name,down):
                    if down:db.execute('INSERT OR IGNORE INTO conditions VALUES(?,?,?,0)',(name,now,now))
                    else:db.execute('DELETE FROM conditions WHERE name=?',(name,))
                # A crash after claiming a job records interrupted state. The
                # bounded retry never interprets an interrupted backup as success.
                for name,job in self.config['jobs'].items():
                    old=db.execute('SELECT next_due,status,failures FROM jobs WHERE name=?',(name,)).fetchone()
                    if old and old[0]>now:continue
                    failures=old[2] if old else 0
                    db.execute('INSERT OR REPLACE INTO jobs VALUES(?,?,?,?,?)',(name,now+job['timeout']+60,'running',failures,0));db.commit()
                    start=time.monotonic()
                    try:success=runner(job) is True
                    except Exception:success=False
                    state='up' if success else 'down';elapsed=round((time.monotonic()-start)*1000)
                    with db:
                        db.execute('UPDATE jobs SET next_due=?,status=?,failures=?,elapsed_ms=? WHERE name=?',(now+job['interval'],state,0 if success else failures+1,elapsed,name))
                        if success:db.execute('INSERT OR REPLACE INTO successes VALUES(?,?)',(name,now))
                        condition('job:'+name,not success)
                        if not old or old[1]!=state:event({'event':'maintenance_job_recovered' if success else 'maintenance_job_failed','job':name})
                policy=self.config['monitor']
                if policy:
                    old=db.execute('SELECT value FROM monitor WHERE id=1').fetchone()
                    try:result=probe(policy)
                    except Exception:result={'ready':False}
                    value,changed=transition(parse(old[0]) if old else None,policy['endpoint'],result,failure_threshold=policy['failure_threshold'],recovery_threshold=policy['recovery_threshold'],now=now)
                    with db:
                        db.execute('INSERT OR REPLACE INTO monitor VALUES(1,?)',(canonical(value),))
                        condition('point',value['status']=='down')
                        if changed:event(changed)
                # Escalation survives restarts and is bounded to three levels.
                # The receiver routes by condition/level without receiving secrets.
                with db:
                    for name,since,last,level in db.execute('SELECT name,down_since,last_escalation,level FROM conditions').fetchall():
                        if level<3 and now-last>=self.config.get('escalation_seconds',3600):
                            event({'event':'maintenance_condition_escalated','condition':name,'level':level+1,'down_since':since})
                            db.execute('UPDATE conditions SET last_escalation=?,level=? WHERE name=?',(now,level+1,name))
                delivered=0
                if self.config['alerts']:
                    for number,raw,attempts,next_due in db.execute('SELECT id,body,attempts,next_due FROM events ORDER BY id LIMIT 16').fetchall():
                        if next_due>now:break
                        body={**parse(raw),'id':hashlib.sha256((pin+':'+str(number)).encode()).hexdigest()}
                        try:sender(self.config['alerts'],body)
                        except Exception:
                            with db:db.execute('UPDATE events SET attempts=?,next_due=? WHERE id=?',(attempts+1,now+min(3600,2**min(attempts,11)*5),number))
                            break  # Preserve transition order across retries.
                        with db:db.execute('DELETE FROM events WHERE id=?',(number,))
                        delivered+=1
                lines=['# TYPE sphere_maintenance_job_up gauge']
                for name,state,failures,elapsed in db.execute('SELECT name,status,failures,elapsed_ms FROM jobs ORDER BY name'):
                    lines.extend([f'sphere_maintenance_job_up{{job="{name}"}} {int(state=="up")}',f'sphere_maintenance_job_failures{{job="{name}"}} {failures}',f'sphere_maintenance_job_elapsed_ms{{job="{name}"}} {elapsed}'])
                for name,completed in db.execute('SELECT name,completed_at FROM successes ORDER BY name'):lines.append(f'sphere_maintenance_job_last_success_seconds{{job="{name}"}} {completed}')
                lines.append(f'sphere_maintenance_last_tick_seconds {now}')
                pending=db.execute('SELECT COUNT(*) FROM events').fetchone()[0];lines.append(f'sphere_maintenance_alerts_pending {pending}')
                import shutil
                disk=shutil.disk_usage(self.folder);lines.extend([f'sphere_maintenance_disk_free_bytes {disk.free}',f'sphere_maintenance_disk_total_bytes {disk.total}'])
                monitor=db.execute('SELECT value FROM monitor WHERE id=1').fetchone()
                if monitor:lines.append('sphere_maintenance_point_up '+str(int(parse(monitor[0])['status']=='up')))
                tmp=self.folder/'metrics.pending'
                if tmp.is_symlink():raise ValueError('metrics_link')
                with tmp.open('w') as output:output.write('\n'.join(lines)+'\n');output.flush();os.fsync(output.fileno())
                os.replace(tmp,self.folder/'metrics.prom')
                return {'jobs':len(self.config['jobs']),'alerts_pending':pending,'alerts_delivered':delivered}

    @staticmethod
    def run_job(job):
        # Output can contain database diagnostics/credentials: never forward it
        # to alerts or logs. Job status is deliberately a constant vocabulary.
        import signal
        child=subprocess.Popen(job['argv'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env={k:v for k,v in os.environ.items() if not k.startswith(('PYTHON','LD_','PIP_'))},start_new_session=True)
        try:return child.wait(timeout=job['timeout'])==0
        except subprocess.TimeoutExpired:
            os.killpg(child.pid,signal.SIGTERM)
            try:child.wait(timeout=130)
            except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
            return False

    @staticmethod
    def probe(policy):
        extra={}
        if 'node_key' in policy:
            from sfera_mesh.identity import load_identity,node_id
            key=load_identity(private_file(policy['node_key']))
            if node_id(key.public_key().public_bytes_raw())!=policy['node']:raise ValueError('maintenance_point_key_changed')
            extra={'key':key,'network':policy['network']}
        return check(policy['endpoint'],context=ssl.create_default_context(cafile=policy['ca_certificate']),**extra)


def timer(python,script,config):
    for path in (python,script,config):
        if not re.fullmatch('/[A-Za-z0-9_./-]+',str(path)):raise ValueError('unambiguous_maintenance_paths')
    service='[Unit]\nDescription=Sphere maintenance tick\n[Service]\nType=oneshot\nUMask=0077\nNoNewPrivileges=true\nTimeoutStartSec=4000\nTimeoutStopSec=150\nExecStart='+str(python)+' -B '+str(script)+' --config '+str(config)+'\n'
    schedule='[Unit]\nDescription=Sphere maintenance schedule\n[Timer]\nOnBootSec=60\nOnUnitActiveSec=60\nAccuracySec=5\nPersistent=true\n[Install]\nWantedBy=timers.target\n'
    return service,schedule


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--config',required=True);args=p.parse_args()
    config=parse(private_file(args.config).read_bytes());print(canonical(Maintenance(config).tick()).decode())


if __name__=='__main__':main()
