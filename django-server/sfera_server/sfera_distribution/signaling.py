"""Peer-to-peer signaling relay; no common broker and no recursive forwarding."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import threading
from urllib.parse import urlsplit
import urllib.request
from sfera_mesh.application_signals import verify_signal, SignalReplayJournal
from sfera_mesh.identity import node_id, envelope, EnvelopeVerifier
from sfera_mesh.storage import canonical


def application_peers(directory):
    from sfera_mesh.discovery import discovered_peers
    from sfera_mesh.network_peers import approved_network_peers
    with directory.lock:
        approved = approved_network_peers(directory)
        discovered = discovered_peers(directory,https_only=True)['peers']
        result = {}
        for identity,public in approved.items():
            parsed = urlsplit(discovered[identity]['endpoint'])
            host = parsed.hostname
            if ':' in host:host = '['+host+']'
            # The point application is served on public HTTPS 443. Its storage
            # endpoint remains independent (normally 8443).
            result[identity] = {'public_key':public,'origin':'https://'+host}
        return result


def post_signal(origin,message):
    from sfera_mesh.consensus_directory import NoRedirect
    from sfera_mesh.public_transport import endpoint_url
    origin = endpoint_url(origin)
    request = urllib.request.Request(origin+'/api/distribution/signals/relay/',data=canonical(message),
        headers={'Content-Type':'application/json','X-Ionik-Client':'1'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    with opener.open(request,timeout=3) as response:
        raw = response.read(4097)
        if response.status != 200 or len(raw)>4096:raise ValueError('signal_relay_response')
    result = json.loads(raw)
    if not isinstance(result,dict) or set(result) != {'routed'} or type(result['routed']) is not bool:
        raise ValueError('signal_relay_response')
    return result


class ApplicationSignalRelay:
    def __init__(self,key,directory,node_replays,signal_replays,*,authorize,local,peers=application_peers,post=post_signal):
        self.key,self.directory = key,directory
        self.identity = node_id(key.public_key().public_bytes_raw())
        self.authorize,self.local,self.peers,self.post = authorize,local,peers,post
        self.nodes = EnvelopeVerifier(directory.network,self.identity,{},node_replays)
        self.signals = SignalReplayJournal(signal_replays)
        self.pool = ThreadPoolExecutor(max_workers=6,thread_name_prefix='mesh-signal')
        self.slots = threading.BoundedSemaphore(8)

    def close(self):
        self.pool.shutdown(wait=True,cancel_futures=True)
        self.nodes.close();self.signals.close()

    def _roster(self):
        with self.directory.lock:
            self.directory.anchor()
            peers = self.peers(self.directory)
            if self.identity not in peers:raise ValueError('signal_entry_not_active')
            return peers

    def receive(self,message,*,now=None):
        peers = self._roster()
        self.nodes.roster = {identity:peer['public_key'] for identity,peer in peers.items()}
        _,payload = self.nodes.verify(message,'application-signal-v1',now=now)
        if not isinstance(payload,dict) or set(payload) != {'packet'}:
            raise ValueError('signal_relay_payload')
        checked = self.signals.accept(payload['packet'],self.directory,now=now)
        # The callback only dispatches locally. A receiver never fans this back
        # out to peers, so a packet cannot circulate around the network.
        return {'routed':self.local(checked,payload['packet']) is True}

    def forward(self,packet,user,claim,*,now=None):
        if not self.slots.acquire(blocking=False):raise ValueError('signal_relay_busy')
        try:return self._forward(packet,user,claim,now=now)
        finally:self.slots.release()

    def _forward(self,packet,user,claim,*,now=None):
        self.authorize(user,claim)
        checked = verify_signal(packet,self.directory,now=now)
        if (not isinstance(claim,dict) or claim.get('owner') != checked['sender_owner']
                or claim.get('device') != checked['device'] or claim.get('entry') != self.identity
                or claim.get('genesis') != self.directory.pin or str(user) != checked['signal']['from']):
            raise ValueError('signal_actor_mismatch')
        peers = self._roster()
        # Check replay even when both participants happen to use this entry.
        self.signals.accept(packet,self.directory,now=now)
        if self.local(checked,packet) is True:return {'routed':True}
        def send(identity,peer):
            message = envelope(self.key,self.directory.network,identity,'application-signal-v1',{'packet':packet},now=now)
            try:return self.post(peer['origin'],message).get('routed') is True
            except (OSError,ValueError,TypeError):return False
        targets=[(identity,peer) for identity,peer in peers.items() if identity != self.identity]
        if not targets:return {'routed':False}
        routed=False
        futures=[self.pool.submit(send,identity,peer) for identity,peer in targets]
        for future in as_completed(futures):routed = future.result() or routed
        return {'routed':routed}
