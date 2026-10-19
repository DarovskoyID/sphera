"""Four real CometBFT processes; isolated temporary state and loopback only."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request
from hashlib import sha256

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'django-server' / 'sfera_server'))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sfera_mesh.directory import user_id, validate_record, ZERO
from sfera_mesh.storage import canonical


def main():
    binary = Path(sys.argv[1]).resolve()
    processes, logs = {}, []
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with tempfile.TemporaryDirectory(prefix='sfera-consensus-') as temp:
        home = Path(temp) / 'lab'
        subprocess.run([str(binary), '--home', str(home), '--init'], check=True)
        lab = json.loads((home / 'lab.json').read_text())

        def rpc(index, method, params=None):
            url = lab['rpc'][index].replace('tcp://', 'http://')
            request = urllib.request.Request(url, data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or {}}).encode(), headers={'Content-Type': 'application/json'})
            with opener.open(request, timeout=3) as response:
                result = json.load(response)
            if 'error' in result:
                raise AssertionError(result['error'])
            return result['result']

        def start(index):
            log = open(Path(temp) / f'{index}-{len(logs)}.log', 'wb')
            logs.append(log)
            processes[index] = subprocess.Popen([str(binary), '--home', str(home), '--validator', str(index)], stdout=log, stderr=log)

        def stop(index):
            process = processes.pop(index)
            process.terminate()
            process.wait(timeout=15)

        def wait_for(check, timeout=45):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                for index, process in processes.items():
                    if process.poll() is not None:
                        raise AssertionError(f'validator {index} exited: {process.returncode}')
                try:
                    result = check()
                    if result:
                        return result
                except (OSError, ValueError):
                    pass
                time.sleep(.15)
            raise AssertionError('consensus condition timed out')

        key = Ed25519PrivateKey.generate()
        pub = key.public_key().public_bytes_raw()
        identity = user_id(pub)

        def record(version, previous):
            body = {'domain': 'sfera-mesh-account-v1', 'network': lab['chain'], 'user_id': identity, 'public_key': pub.hex(), 'version': version, 'previous': previous, 'vault_digest': sha256(f'vault-{version}'.encode()).hexdigest(), 'dialogs_digest': sha256(b'encrypted-index').hexdigest()}
            result = {'body': body, 'signature': key.sign(canonical(body)).hex()}
            validate_record(result, lab['chain'])  # Cross-language canonical/signature compatibility.
            return result

        def submit(item):
            return rpc(0, 'broadcast_tx_sync', {'tx': base64.b64encode(canonical(item)).decode()})

        def head(index):
            response = rpc(index, 'abci_query', {'path': '/account', 'data': identity.encode().hex(), 'prove': False})['response']
            if response.get('code', 0):
                return None
            return json.loads(base64.b64decode(response['value']))

        try:
            for i in range(4):
                start(i)
            wait_for(lambda: all(int(rpc(i, 'status')['sync_info']['latest_block_height']) >= 2 for i in processes))
            first = record(1, ZERO)
            assert submit(first)['code'] == 0
            wait_for(lambda: all(head(i) and head(i)['record'] == first for i in processes))
            second = record(2, sha256(canonical(first)).hexdigest())
            stop(3)
            assert submit(second)['code'] == 0
            wait_for(lambda: all(head(i)['record'] == second for i in processes))
            stop(2)
            # Allow any block already signed before disconnection to finish.
            time.sleep(2)
            heights = [int(rpc(i, 'status')['sync_info']['latest_block_height']) for i in processes]
            third = record(3, sha256(canonical(second)).hexdigest())
            assert submit(third)['code'] == 0  # Mempool acceptance is NOT finality.
            time.sleep(4)
            assert all(head(i)['record'] == second for i in processes)
            assert heights == [int(rpc(i, 'status')['sync_info']['latest_block_height']) for i in processes]
            start(2)
            wait_for(lambda: all(head(i) and head(i)['record'] == third for i in processes), timeout=60)
            start(3)
            wait_for(lambda: head(3) and head(3)['record'] == third, timeout=60)
            # Owner-signed competing version cannot overwrite the finalized head.
            fork = record(3, sha256(canonical(second)).hexdigest())
            fork['body']['vault_digest'] = 'a' * 64
            fork['signature'] = key.sign(canonical(fork['body'])).hex()
            assert submit(fork)['code'] != 0
            for i in list(processes):
                stop(i)
            for i in range(4):
                start(i)
            wait_for(lambda: all(head(i) and head(i)['record'] == third for i in processes), timeout=60)
            print('Consensus passed: four processes, owner records, one failure, quorum loss, catch-up, fork rejection, durable restart.')
        except BaseException:
            for log in logs:
                log.flush()
            for path in Path(temp).glob('*.log'):
                content = path.read_text(errors='replace')
                if content:
                    print(path.name, content[-3000:], file=sys.stderr)
            raise
        finally:
            for i in list(processes):
                stop(i)
            for log in logs:
                log.close()


if __name__ == '__main__':
    main()
