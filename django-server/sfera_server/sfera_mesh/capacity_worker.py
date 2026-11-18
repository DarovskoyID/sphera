"""Keep slow positive probes out of the replacement/failure control loop."""
import threading


class CapacityWorker:
    def __init__(self,renewal,*,interval=2):
        if type(interval) not in (int,float) or not .1<=interval<=10:
            raise ValueError('invalid_capacity_worker_interval')
        nodes=tuple(sorted(renewal.domains))
        if not 1<=len(nodes)<=64:
            raise ValueError('bounded_capacity_targets_required')
        self.renewal,self.nodes,self.interval=renewal,nodes,interval
        self.lock=threading.Lock()
        self.stopped=threading.Event()
        self.thread=None
        self.results={}
        self.error=None

    def start(self):
        with self.lock:
            if self.thread is not None: raise ValueError('capacity_worker_already_started')
            self.thread=threading.Thread(target=self._run,name='mesh-capacity-renewal',daemon=True)
            self.thread.start()
        return self

    def _run(self):
        try:
            while not self.stopped.is_set():
                for node in self.nodes:
                    if self.stopped.is_set(): return
                    result=self.renewal.step(node)
                    with self.lock: self.results[node]=dict(result)
                self.stopped.wait(self.interval)
        except Exception:
            # Do not leak signed payloads or exceptions containing addresses.
            with self.lock: self.error='capacity_worker_failed'
            self.stopped.set()

    def status(self):
        with self.lock:
            return {'running':bool(self.thread and self.thread.is_alive()),'error':self.error,
                    'nodes':{node:dict(result) for node,result in self.results.items()}}

    def stop(self,*,timeout=45):
        if type(timeout) not in (int,float) or not 0<=timeout<=45: raise ValueError('invalid_capacity_stop_timeout')
        self.stopped.set()
        if self.thread is not None: self.thread.join(timeout)
        return not (self.thread and self.thread.is_alive())
