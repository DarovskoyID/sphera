"""Run an isolated loopback directory refresher; no production routes or joining."""
import argparse
import json
from pathlib import Path
import signal
import sys
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'django-server' / 'sfera_server'))
from sfera_mesh.consensus_directory import ConsensusDirectory
from sfera_mesh.consensus_updater import ConsensusUpdater


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True)
    parser.add_argument('--genesis', required=True, help='locally pinned genesis file')
    parser.add_argument('--state', required=True, help='dedicated laboratory SQLite file')
    parser.add_argument('--rpc', required=True, action='append', help='explicit loopback consensus source; repeat for fallback')
    options = parser.parse_args()
    stopping = threading.Event()
    for name in (signal.SIGINT, signal.SIGTERM):
        signal.signal(name, lambda *_: stopping.set())
    directory = ConsensusDirectory(options.state, options.binary, options.genesis)
    updater = None
    try:
        updater = ConsensusUpdater(directory, options.rpc)
        updater.start()
        previous = None
        while not stopping.is_set():
            status = updater.status()
            # Log only changes in readiness/error, never account records or tokens.
            current = (status['running'], status['role'], status['ready'], status['last_error'])
            if current != previous:
                print(json.dumps(status), flush=True)
                previous = current
            if not status['running']:
                return 1
            stopping.wait(1)
        return 0
    finally:
        if updater is not None:
            updater.stop()
        directory.close()


if __name__ == '__main__':
    sys.exit(main())
