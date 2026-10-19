"""Four real CometBFT processes; isolated temporary state and loopback only."""
import base64
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from unittest.mock import patch
from hashlib import sha256

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'django-server' / 'sfera_server'))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sfera_mesh.directory import user_id, validate_record, ZERO
from sfera_mesh.storage import canonical
from sfera_mesh.consensus_directory import ConsensusDirectory, ConsensusUnavailable, fetch_evidence
from sfera_mesh.auth import MeshAuth, DirectoryNotReady, LoginRequestChanged
from sfera_mesh.identity import EnvelopeVerifier
from sfera_mesh.transport import BlobStore, LabServer


def verify_http_login(auth, directory, owner, identity):
    verifier = EnvelopeVerifier(auth.network, auth.entry_node, {auth.entry_node: auth.key.public_key().public_bytes_raw()}, ':memory:')
    blobs = BlobStore(':memory:')
    server = LabServer(auth.key, verifier, blobs, directory, auth)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def request(operation, payload, token=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        req = urllib.request.Request(server.endpoint + '/mesh-lab/auth/' + operation, data=canonical(payload), headers=headers)
        with opener.open(req, timeout=4) as response:
            return json.load(response)['body']
    try:
        challenge = request('challenge', {'user_id': identity, 'client_nonce': '3' * 64})
        session = request('complete', {'challenge_id': challenge['challenge_id'], 'signature': owner.sign(canonical(challenge)).hex()})
        token = session['token']
        request('session', {'client_nonce': '4' * 64}, token)
        with patch('sfera_mesh.auth.time.time', return_value=int(time.time()) + 40):
            try:
                request('session', {'client_nonce': '5' * 64}, token)
            except urllib.error.HTTPError as error:
                try:
                    assert error.code == 503
                finally:
                    error.close()
            else:
                raise AssertionError('stale consensus HTTP read was allowed')
            assert request('logout', {'client_nonce': '6' * 64}, token)['revoked']
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=3)
        verifier.close()
        blobs.close()


def main():
    binary = Path(sys.argv[1]).resolve()
    processes, logs = {}, []
    directory = auth = None
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
            address = lab['rpc'][0].replace('tcp://', 'http://')
            genesis = home / '0' / 'config' / 'genesis.json'
            directory = ConsensusDirectory(str(Path(temp) / 'verified.sqlite'), binary, genesis)
            wait_for(lambda: directory.refresh(address))
            assert directory.get(identity)['record'] == first
            old_evidence = fetch_evidence(address)
            # Every attack leaves the prior verified cache usable.
            attacks = []
            forged = copy.deepcopy(old_evidence)
            changed = forged['state']['accounts'][identity]
            changed['record']['body']['vault_digest'] = 'a' * 64
            changed['record']['signature'] = key.sign(canonical(changed['record']['body'])).hex()
            changed['digest'] = sha256(canonical(changed['record'])).hexdigest()
            attacks.append(forged)
            forged = copy.deepcopy(old_evidence)
            forged['signed_header']['commit']['signatures'] = forged['signed_header']['commit']['signatures'][:2]
            attacks.append(forged)
            forged = copy.deepcopy(old_evidence)
            forged['state']['network'] = 'another-network'
            attacks.append(forged)
            forged = copy.deepcopy(old_evidence)
            forged['signed_header']['header']['time'] = '2000-01-01T00:00:00Z'
            attacks.append(forged)
            forged = copy.deepcopy(old_evidence)
            forged['signed_header']['header']['validators_hash'] = 'A' * 64
            attacks.append(forged)
            for attack in attacks:
                try:
                    directory.import_evidence(attack)
                except ValueError:
                    pass
                else:
                    raise AssertionError('forged consensus proof accepted')
                assert directory.get(identity)['record'] == first
            second = record(2, sha256(canonical(first)).hexdigest())
            stop(3)
            assert submit(second)['code'] == 0
            wait_for(lambda: all(head(i)['record'] == second for i in processes))
            wait_for(lambda: directory.refresh(address) and directory.get(identity)['record'] == second)
            try:
                directory.import_evidence(old_evidence)
            except ValueError:
                pass
            else:
                raise AssertionError('old valid consensus state rolled back the directory')
            directory.close()
            directory = ConsensusDirectory(str(Path(temp) / 'verified.sqlite'), binary, genesis)
            directory.restore()
            assert directory.get(identity)['record'] == second
            other_genesis = Path(temp) / 'other-genesis.json'
            changed_genesis = json.loads(genesis.read_bytes())
            changed_genesis['chain_id'] = 'another-network'
            other_genesis.write_bytes(canonical(changed_genesis))
            try:
                ConsensusDirectory(str(Path(temp) / 'verified.sqlite'), binary, other_genesis)
            except ValueError:
                pass
            else:
                raise AssertionError('pinned genesis changed on restart')
            try:
                directory.import_evidence(old_evidence)
            except ValueError:
                pass
            else:
                raise AssertionError('restart lost the durable high-water mark')
            auth = MeshAuth(str(Path(temp) / 'auth.sqlite'), Ed25519PrivateKey.generate(), directory)
            verify_http_login(auth, directory, key, identity)
            challenge = auth.challenge(identity, 'a' * 64)
            proof = key.sign(canonical(challenge['body'])).hex()
            session = auth.complete(challenge['body']['challenge_id'], proof)['body']
            token = session['token']
            auth.session(token, 'b' * 64)
            pending = auth.challenge(identity, 'c' * 64)
            try:
                auth.set_read_lease({})
            except ValueError:
                pass
            else:
                raise AssertionError('fixture read lease allowed on consensus-backed login')
            future = int(time.time()) + 40
            try:
                auth.session(token, 'd' * 64, now=future)
            except DirectoryNotReady:
                pass
            else:
                raise AssertionError('stale consensus allowed session access')
            # Temporary consensus failure does not revoke an existing session.
            auth.session(token, 'e' * 64)
            with patch('sfera_mesh.consensus_directory.time.time', return_value=time.time() + 40):
                try:
                    directory.get(identity)
                except ConsensusUnavailable:
                    pass
                else:
                    raise AssertionError('expired snapshot still authorized a read')
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
            wait_for(lambda: directory.refresh(address) and directory.get(identity)['record'] == third)
            try:
                auth.complete(pending['body']['challenge_id'], key.sign(canonical(pending['body'])).hex())
            except (LoginRequestChanged, ValueError):
                pass
            else:
                raise AssertionError('old account challenge accepted after consensus update')
            auth.session(token, 'f' * 64)
            auth.logout(token, '1' * 64)
            try:
                auth.session(token, '2' * 64)
            except ValueError:
                pass
            else:
                raise AssertionError('logged-out session still accepted')
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
            print('Consensus passed: four processes, quorum loss/recovery, durable restart; pinned commit verification, snapshot binding, tamper/rollback rejection and freshness.')
        except BaseException:
            for log in logs:
                log.flush()
            for path in Path(temp).glob('*.log'):
                content = path.read_text(errors='replace')
                if content:
                    print(path.name, content[-3000:], file=sys.stderr)
            raise
        finally:
            if auth is not None:
                auth.close()
            if directory is not None:
                directory.close()
            for i in list(processes):
                stop(i)
            for log in logs:
                log.close()


if __name__ == '__main__':
    main()
