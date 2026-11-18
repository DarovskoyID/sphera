"""Opt-in orchestration of operator-requested, quorum-authorized controller jobs."""
from hashlib import sha256
from pathlib import Path
import re
import threading
from .directory import digest64
from .initial_controller import InitialController
from .manifest_publisher import ManifestPublisher
from .capacity_renewal import CapacityRenewal
from .failure_coordinator import FailureCoordinator
from .storage import canonical
from .manifest_queue import ManifestQueue


def validate_policy(value,peers):
    if not isinstance(value,dict) or not value or not set(value)<={'initial_count','manifests','capacity','failure','manifest_queue','discovery'}:raise ValueError('controller_policy_schema')
    for flag in ('manifest_queue','discovery'):
        if flag in value and type(value[flag]) is not bool:raise ValueError('explicit_controller_boolean_required')
    if not (set(value)&{'initial_count','manifests','capacity','failure'} or value.get('manifest_queue')):raise ValueError('controller_jobs_required')
    if not 3<=len(peers)<=64:raise ValueError('bounded_controller_roster_required')
    if 'initial_count' in value and (type(value['initial_count']) is not int or not 1<=value['initial_count']<=4):raise ValueError('bounded_initial_count_required')
    if 'manifests' in value:
        manifests=value['manifests']
        if not isinstance(manifests,list) or not 1<=len(manifests)<=8:raise ValueError('bounded_manifest_requests_required')
        clusters=set()
        for job in manifests:
            if not isinstance(job,dict) or set(job)!={'cluster','sizes'} or not digest64(job['cluster']) or job['cluster'] in clusters:raise ValueError('unique_manifest_request_required')
            sizes=job['sizes']
            if not isinstance(sizes,dict) or not 1<=len(sizes)<=16 or any(not digest64(d) or type(s) is not int or not 1<=s<=262144 for d,s in sizes.items()):raise ValueError('bounded_manifest_sizes_required')
            clusters.add(job['cluster'])
    for role in ('capacity','failure'):
        if role not in value:continue
        policy=value[role];expected={'assessors','failure_domains','slots'} if role=='capacity' else {'assessors','clusters'}
        if not isinstance(policy,dict) or set(policy)!=expected or not isinstance(policy['assessors'],dict) or len(policy['assessors'])!=4:raise ValueError('four_controller_assessors_required')
        observers=set()
        for assessor,item in policy['assessors'].items():
            if (not digest64(assessor) or not isinstance(item,dict) or set(item)!={'observer','endpoint'}
                    or item['observer'] not in peers or item['observer'] in observers or item['endpoint']!=peers[item['observer']]['endpoint']):raise ValueError('pinned_controller_assessor_binding_required')
            observers.add(item['observer'])
        if role=='capacity':
            domains=policy['failure_domains']
            if (not isinstance(domains,dict) or not 1<=len(domains)<=8 or not set(domains)<=set(peers)
                    or any(not isinstance(d,str) or not re.fullmatch('[a-zA-Z0-9._-]{1,64}',d) for d in domains.values())
                    or type(policy['slots']) is not int or policy['slots'] not in (1,2)):raise ValueError('bounded_controller_capacity_targets_required')
        elif not isinstance(policy['clusters'],list) or not 1<=len(policy['clusters'])<=8 or any(not digest64(c) for c in policy['clusters']) or len(set(policy['clusters']))!=len(policy['clusters']):raise ValueError('bounded_unique_failure_clusters_required')
    return value


def database_names(policy):
    names=[]
    if 'initial_count' in policy:names.append('controller-initial.sqlite')
    if 'capacity' in policy:names.append('controller-capacity.sqlite')
    if 'failure' in policy:names.append('controller-failure.sqlite')
    if policy.get('manifest_queue'):names.append('controller-manifestq.sqlite')
    for job in policy.get('manifests',[]):names.append('controller-m-'+sha256(canonical(job)).hexdigest()+'.sqlite')
    return names


class ControllerLoop:
    """One role per thread; slow positive probes cannot block failure handling."""
    def __init__(self,name,jobs,*,interval=2):
        if not jobs or not .01<=interval<=10:raise ValueError('bounded_controller_loop_required')
        self.name,self.jobs,self.interval=name,tuple(jobs),interval
        self.stopped=threading.Event();self.lock=threading.Lock();self.thread=None;self.results={};self.error=None

    def start(self):
        if self.thread is not None:raise ValueError('controller_loop_already_started')
        self.thread=threading.Thread(target=self._run,name='mesh-controller-'+self.name,daemon=True);self.thread.start();return self

    def _run(self):
        index=0
        try:
            while not self.stopped.is_set():
                name,step=self.jobs[index];result=step()
                with self.lock:self.results[name]=dict(result)
                index=(index+1)%len(self.jobs);self.stopped.wait(self.interval)
        except Exception:
            with self.lock:self.error='controller_loop_failed'
            self.stopped.set()

    def status(self):
        with self.lock:return {'running':bool(self.thread and self.thread.is_alive()),'error':self.error,'jobs':{name:dict(value) for name,value in self.results.items()}}

    def stop(self):
        self.stopped.set()
        if self.thread is not None:self.thread.join(timeout=45)
        if self.thread is not None and self.thread.is_alive():raise RuntimeError('controller_loop_did_not_stop')


class ControllerRuntime:
    def __init__(self,state,directory,address,key,verifier,peers,policy,*,store=None):
        validate_policy(policy,peers);self.controllers=[];self.loops=[];self.manifest_queue=None
        if directory.endpoint_policy!='https-v1':raise ValueError('controller_genesis_https_policy_required')
        endpoints={identity:item['endpoint'] for identity,item in peers.items()};state=Path(state)
        def own(controller):self.controllers.append(controller);return controller
        try:
            if policy.get('manifest_queue'):
                if store is None:raise ValueError('manifest_queue_store_required')
                self.manifest_queue=own(ManifestQueue(state/'controller-manifestq.sqlite',directory,address,key,verifier,endpoints,store))
                self.loops.append(ControllerLoop('manifest-queue',[('queue',self.manifest_queue.step)]))
            if 'initial_count' in policy:
                controller=own(InitialController(state/'controller-initial.sqlite',directory,address,key,verifier,endpoints,count=policy['initial_count']))
                self.loops.append(ControllerLoop('initial',[('initial',controller.step)]))
            manifests=[]
            for job in policy.get('manifests',[]):
                name='controller-m-'+sha256(canonical(job)).hexdigest()+'.sqlite'
                controller=own(ManifestPublisher(state/name,directory,address,key,verifier,endpoints,cluster=job['cluster'],sizes=job['sizes']))
                manifests.append((job['cluster'],controller.step))
            if manifests:self.loops.append(ControllerLoop('manifest',manifests))
            if 'capacity' in policy:
                p=policy['capacity'];controller=own(CapacityRenewal(state/'controller-capacity.sqlite',directory,address,key,verifier,p['assessors'],p['failure_domains'],slots=p['slots']))
                self.loops.append(ControllerLoop('capacity',[(node,lambda node=node,c=controller:c.step(node)) for node in sorted(p['failure_domains'])]))
            if 'failure' in policy:
                p=policy['failure'];controller=own(FailureCoordinator(state/'controller-failure.sqlite',directory,address,key,verifier,p['assessors']))
                self.loops.append(ControllerLoop('failure',[(cluster,lambda cluster=cluster,c=controller:c.step(cluster)) for cluster in p['clusters']]))
        except BaseException:
            for controller in reversed(self.controllers):controller.close()
            raise

    def start(self):
        try:
            for loop in self.loops:loop.start()
        except BaseException:
            for loop in self.loops:loop.stop()
            raise
        return self

    def status(self):
        roles={loop.name:loop.status() for loop in self.loops}
        return {'running':all(role['running'] for role in roles.values()),'roles':roles,'authority':'existing_peer_consents_and_genesis_assessors_only'}

    def stop(self):
        for loop in self.loops:loop.stop()

    def close(self):
        self.stop()
        for controller in reversed(self.controllers):controller.close()
