"""Durable, all-or-nothing generation admission; never splits a batch."""
import base64
from hashlib import sha256
import json
import time
from urllib.error import HTTPError

from cryptography.exceptions import InvalidSignature

from .consensus_directory import rpc
from .directory import digest64
from .identity import node_id
from .storage import canonical
from .transport import exchange
from .write_capacity import check_write_capacity
from .write_queue import content_request_id, request_id, validate_write, validate_write_body


def committed(state, body):
    manifest = state.get('manifests', {}).get(body['cluster'], {}).get('record', {}).get('body', {})
    values, sizes = manifest.get('digests', []), manifest.get('sizes')
    return sizes is not None and body['digest'] in values and sizes[values.index(body['digest'])] == body['size']


def reserve_many(queue, requests):
    if not queue.content_bound:
        raise ValueError('content_bound_write_queue_required')
    if (not isinstance(requests, list) or not 1 <= len(requests) <= 4096 or
            any(not isinstance(item, dict) or set(item) != {'cluster', 'block_token', 'digest', 'size'} or
                any(not digest64(item[key]) for key in ('cluster', 'block_token', 'digest')) or
                type(item['size']) is not int or not 1 <= item['size'] <= 262144 for item in requests)):
        raise ValueError('invalid_write_batch_requests')
    requests = sorted(requests, key=lambda item: (item['cluster'], item['block_token']))
    if len({(item['cluster'], item['block_token']) for item in requests}) != len(requests):
        raise ValueError('duplicate_write_batch_token')
    raw_requests = canonical(requests)
    if len(raw_requests) > 1048576: raise ValueError('write_batch_input_limit')
    identity = sha256(raw_requests).hexdigest()
    with queue.lock:
        if not queue.process_lock.acquire(): return {'state': 'busy', 'error': None}
        try:
            publication = queue.publication
            directory, journal = publication.directory, publication.journal
            directory.refresh(publication.address)
            with directory.lock, journal.lock:
                directory.anchor()
                if journal.db.execute('SELECT pin FROM replica_trust').fetchone() != (directory.pin,):
                    raise ValueError('placement_trust_changed')
                state = json.loads(canonical(directory.current['state']))
                origin, network = journal.verifier.recipient, directory.network
            # All evidence comes from one freshly authenticated snapshot.
            bodies = []
            for item in requests:
                body = {**item, 'origin': origin, 'network': network,
                        'request_id': content_request_id(network, item['cluster'], origin,
                            item['block_token'], item['digest'], item['size'])}
                bodies.append(body)
            with queue.db:
                for old_id, raw, signed in queue.db.execute('SELECT id,requests,record FROM write_batch_outbox').fetchall():
                    previous_requests, previous_record = json.loads(raw), json.loads(signed)
                    if (not isinstance(previous_requests, list) or not 1 <= len(previous_requests) <= 4096 or
                            canonical(previous_requests) != raw or sha256(raw).hexdigest() != old_id or
                            canonical(previous_record) != signed):
                        raise ValueError('corrupt_write_batch_outbox')
                    validate_batch(previous_record, network, state)
                    expected = {canonical(item) for item in previous_requests}
                    if any(canonical({key: item['body'][key] for key in ('cluster', 'block_token', 'digest', 'size')}) not in expected or
                            item['body']['origin'] != origin for item in previous_record['body']['writes']):
                        raise ValueError('write_batch_outbox_context_changed')
                    if all(committed(state, item) for item in previous_requests):
                        queue.db.execute('DELETE FROM write_batch_outbox WHERE id=?', (old_id,))
            accepted = state.get('write_queue', {})
            if all(committed(state, body) or body['request_id'] in accepted for body in bodies):
                return {'state': 'queued', 'error': None, 'batch_id': identity}
            row = queue.db.execute('SELECT requests,record,retry_at FROM write_batch_outbox WHERE id=?', (identity,)).fetchone()
            if row:
                if row[0] != raw_requests: raise ValueError('write_batch_context_changed')
                record = json.loads(row[1])
                if canonical(record) != row[1]: raise ValueError('noncanonical_write_batch_outbox')
                validate_batch(record, network, state)
                allowed = {(body['cluster'], body['block_token'], body['digest'], body['size']) for body in bodies}
                if any((r['body']['cluster'], r['body']['block_token'], r['body']['digest'], r['body']['size']) not in allowed or r['body']['origin'] != origin for r in record['body']['writes']):
                    raise ValueError('write_batch_outbox_context_changed')
                saved_ids = {item['body']['request_id'] for item in record['body']['writes']}
                if any(not committed(state, body) and body['request_id'] not in accepted and body['request_id'] not in saved_ids for body in bodies):
                    raise ValueError('incomplete_write_batch_outbox')
                if row[2] > time.time(): return {'state': 'waiting', 'error': None, 'batch_id': identity}
            else:
                if queue.db.execute('SELECT COUNT(*) FROM write_batch_outbox').fetchone()[0]:
                    return {'state': 'blocked', 'error': 'another_write_batch_pending'}
                pending = [body for body in bodies if not committed(state, body) and body['request_id'] not in accepted]
                if len(pending) > 128 or len(set(accepted) | {body['request_id'] for body in pending}) > 128:
                    return {'state': 'blocked', 'error': 'write_batch_queue_capacity_exhausted'}
                additions = {}
                for body in pending:
                    sizes = additions.setdefault(body['cluster'], {})
                    if body['digest'] in sizes and sizes[body['digest']] != body['size']:
                        raise ValueError('write_batch_size_conflict')
                    sizes[body['digest']] = body['size']
                    legacy = request_id(network, body['cluster'], origin, body['block_token'])
                    if legacy in accepted or queue.db.execute('SELECT 1 FROM write_outbox WHERE id=?', (legacy,)).fetchone():
                        return {'state': 'blocked', 'error': 'legacy_write_pending'}
                for cluster, sizes in additions.items(): check_write_capacity(state, cluster, sizes)
                records = []
                refreshed = time.monotonic()
                for body in pending:
                    if time.monotonic() - refreshed >= 5:
                        directory.refresh(publication.address)
                        with directory.lock:
                            directory.anchor()
                            if any(directory.current['state']['placements'][cluster]['digest'] != state['placements'][cluster]['digest'] for cluster in additions):
                                raise ValueError('write_batch_placement_changed')
                        refreshed = time.monotonic()
                    placement = state['placements'][body['cluster']]
                    body.update(domain='sfera-mesh-write-v2', epoch=placement['record']['body']['epoch'], placement_hash=placement['digest'])
                    validate_write_body(body, network, placement)
                    consents = []
                    for member in placement['record']['body']['members']:
                        result = exchange(journal.endpoints[member], journal.key, journal.verifier, member,
                            'write-consent', {'body': body})
                        if result['body_hash'] != sha256(canonical(body)).hexdigest() or node_id(bytes.fromhex(result['consent']['public_key'])) != member:
                            raise ValueError('write_consent_response_mismatch')
                        consents.append(result['consent'])
                    record = {'body': body, 'consents': sorted(consents, key=lambda item: item['public_key'])}
                    validate_write(record, network, placement)
                    records.append(record)
                record = {'body': {'domain': 'sfera-mesh-write-batch-v2', 'network': network,
                    'writes': sorted(records, key=lambda item: item['body']['request_id'])}}
                raw = canonical(record)
                if len(raw) > 262144: return {'state': 'blocked', 'error': 'write_batch_byte_limit'}
                with queue.db:
                    queue.db.execute('INSERT INTO write_batch_outbox VALUES(?,?,?,0)', (identity, raw_requests, raw))
            result = rpc(publication.address, 'broadcast_tx_sync', {'tx': base64.b64encode(canonical(record)).decode()})
            if result.get('code', 0): raise ValueError('write_batch_transaction_rejected')
            with queue.db:
                queue.db.execute('UPDATE write_batch_outbox SET retry_at=? WHERE id=?', (time.time() + 2, identity))
            return {'state': 'submitted', 'error': None, 'batch_id': identity}
        except (OSError, InvalidSignature, KeyError, TypeError) as exc:
            if isinstance(exc, HTTPError): exc.close()
            return {'state': 'waiting', 'error': 'write_batch_unavailable'}
        finally:
            queue.process_lock.release()


def validate_batch(record, network, state):
    if (not isinstance(record, dict) or set(record) != {'body'} or not isinstance(record['body'], dict) or
            set(record['body']) != {'domain', 'network', 'writes'} or
            record['body']['domain'] != 'sfera-mesh-write-batch-v2' or record['body']['network'] != network or
            not isinstance(record['body']['writes'], list) or not 1 <= len(record['body']['writes']) <= 128 or
            len(canonical(record)) > 262144):
        raise ValueError('invalid_write_batch')
    previous = ''
    for item in record['body']['writes']:
        body = item['body']
        if body['domain'] != 'sfera-mesh-write-v2' or body['request_id'] <= previous:
            raise ValueError('sorted_distinct_content_bound_writes_required')
        history = state['placement_history'][body['cluster']]
        if type(body['epoch']) is not int or not 1 <= body['epoch'] <= len(history):
            raise ValueError('write_batch_placement_history_required')
        validate_write(item, network, history[body['epoch'] - 1])
        previous = body['request_id']
