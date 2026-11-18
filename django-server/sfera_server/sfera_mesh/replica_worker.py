"""Bounded background copies from verified placement/manifest state only.

Does not propose placements, fabricate capacity or acquire voting authority.
"""
import sqlite3
import threading
from .consensus_directory import ConsensusDirectory
from .identity import node_id
from .replication import ReplicaJournal


class VerifiedReplicaWorker:
    def __init__(self,path,key,directory,bootstrap_rpc,replay_path,*,tls_context=None,interval=2,batch_size=4):
        if not isinstance(directory,ConsensusDirectory) or directory.endpoint_policy!='https-v1' or len(directory.placement_assessors)!=4:raise ValueError('pinned_https_and_placement_policy_required')
        if type(interval) is not int or not 1<=interval<=30 or type(batch_size) is not int or not 1<=batch_size<=8:raise ValueError('bounded_replication_worker_policy')
        self.path,self.key,self.directory,self.bootstrap_rpc,self.replay_path=path,key,directory,bootstrap_rpc,replay_path
        self.tls_context,self.interval,self.batch_size=tls_context,interval,batch_size
        self.identity=node_id(key.public_key().public_bytes_raw());self.stopped=threading.Event();self.thread=None;self.journal=None
        self.lock=threading.RLock();self.result={'initialized':False,'error':None,'processed':0}

    def start(self):
        if self.thread is not None:raise ValueError('replication_worker_already_started')
        self.thread=threading.Thread(target=self._run,name='mesh-verified-replication',daemon=True);self.thread.start();return self

    def status(self):
        with self.lock:return {**self.result,'running':bool(self.thread and self.thread.is_alive()),'placement_authorised':False}

    def stop(self):
        self.stopped.set()
        if self.thread is not None:
            self.thread.join(timeout=20)
            if self.thread.is_alive():raise RuntimeError('replication_worker_did_not_stop')

    def run_once(self):
        if self.journal is None:
            self.journal=ReplicaJournal.from_discovery(self.path,self.key,self.directory,self.bootstrap_rpc,self.replay_path,https_only=True,tls_context=self.tls_context,stop_event=self.stopped)
        self.journal.refresh_discovery()
        with self.directory.lock:
            self.directory.anchor()
            clusters=sorted(cluster for cluster,head in self.directory.current['state'].get('placements',{}).items() if self.identity in head['record']['body']['members'])
            if len(clusters)>2:raise ValueError('replication_membership_limit')
        processed=0
        for cluster in clusters:
            if self.stopped.is_set():break
            # Revalidate under the directory lock; never copy a peer's local
            # placement proposal or guessed failure-domain/capacity profile.
            with self.directory.lock:
                self.directory.anchor()
                if self.identity not in self.directory.placement(cluster)['record']['body']['members']:continue
                profiles=self.directory.placement_candidates(cluster=cluster)
                self.journal.apply_confirmed_placement(self.directory,cluster,profiles)
                if cluster not in self.directory.current['state'].get('manifests',{}):continue
                self.journal.enqueue_confirmed_manifest(self.directory,cluster)
                self.journal.schedule_recheck(cluster,limit=self.batch_size)
            # Never hold the directory lock during HTTPS: a local target must
            # be able to verify the same state on its server thread.
            processed+=self.journal.run_batch(cluster,limit=self.batch_size,stop_event=self.stopped)['processed']
        return processed

    def _run(self):
        try:
            while not self.stopped.is_set():
                try:
                    processed=self.run_once();result={'initialized':self.journal is not None,'error':None,'processed':processed}
                except (ValueError,OSError,sqlite3.Error):result={'initialized':self.journal is not None,'error':'waiting_for_verified_replication_state','processed':0}
                with self.lock:self.result=result
                self.stopped.wait(self.interval)
        except Exception:
            with self.lock:self.result['error']='replication_worker_internal_error'
        finally:
            if self.journal is not None:self.journal.close()
