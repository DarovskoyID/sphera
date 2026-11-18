"""Local mesh reachability lab. Never authorises or applies storage replacements."""
import argparse
import json
from pathlib import Path
import signal
import sys
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'django-server' / 'sfera_server'))
from sfera_mesh.health import HealthJournal, HealthMonitor
from sfera_mesh.identity import load_identity, node_id, EnvelopeVerifier


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--identity', required=True, help='local mesh NODE key, never a user archive key')
    parser.add_argument('--roster', required=True, help='operator-pinned network/nodes JSON')
    parser.add_argument('--state', required=True, help='dedicated laboratory health SQLite file')
    parser.add_argument('--replays', required=True, help='dedicated transport replay SQLite file')
    args = parser.parse_args()
    config = json.loads(Path(args.roster).read_bytes())
    if set(config) != {'network','nodes'} or not isinstance(config['nodes'], dict) or not 1 <= len(config['nodes']) <= 64:
        parser.error('Expected explicit network and up to 64 pinned nodes')
    key = load_identity(args.identity)
    public = {node:bytes.fromhex(item['public_key']) for node,item in config['nodes'].items()}
    endpoints = {node:item['endpoint'] for node,item in config['nodes'].items()}
    verifier = EnvelopeVerifier(config['network'], node_id(key.public_key().public_bytes_raw()), public, args.replays)
    journal = monitor = None
    stopped = threading.Event()
    for name in (signal.SIGINT, signal.SIGTERM):
        signal.signal(name, lambda *_: stopped.set())
    try:
        journal = HealthJournal(args.state, key, verifier, endpoints)
        monitor = HealthMonitor(journal).start()
        previous = None
        while not stopped.is_set():
            status = {node:journal.status(node)['state'] for node in endpoints}
            current = (tuple(sorted(status.items())), monitor.error)
            if current != previous:
                print(json.dumps({'observations':status,'error':monitor.error,'replacement_authorised':False}), flush=True)
                previous = current
            if not monitor.thread.is_alive():
                return 1
            stopped.wait(1)
        return 0
    finally:
        if monitor is not None: monitor.stop()
        if journal is not None: journal.close()
        verifier.close()


if __name__ == '__main__':
    sys.exit(main())
