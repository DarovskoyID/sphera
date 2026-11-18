"""Transport roster derived only from fresh, verified network membership."""
import time
from .discovery import discovered_peers


def approved_network_peers(directory):
    with directory.lock:
        snapshot=discovered_peers(directory,https_only=True);state=directory.current['state'];now=time.time();result={}
        for identity,peer in snapshot['peers'].items():
            candidate=state.get('candidates',{}).get(identity)
            if candidate and candidate['record']['body']['available'] and candidate['record']['body']['license']['claims']['expires_at']>now:
                result[identity]=bytes.fromhex(peer['public_key'])
        return result
