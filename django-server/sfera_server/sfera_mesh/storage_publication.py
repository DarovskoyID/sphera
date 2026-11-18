"""Local laboratory write queue. Index inclusion is not a product message receipt."""
from hashlib import sha256

from .directory import digest64
from .storage import canonical
from .manifest_reads import validate_size_queries, verified_manifests, check_sizes


class StoragePublication:
    def __init__(self, storage, publication, queue=None):
        self.storage, self.publication = storage, publication
        self.queue = queue

    def append(self, dialog, block_id, cluster, ciphertexts):
        values = list(ciphertexts)
        if not digest64(cluster) or not all(isinstance(value, str) and value for value in (dialog, block_id)):
            raise ValueError('invalid_publication_identity')
        if not values or any(not isinstance(value, bytes) or not value for value in values):
            raise ValueError('ciphertext_required')
        payload = canonical([value.hex() for value in values])
        if len(payload) > 262144:
            raise ValueError('bounded_ciphertext_required')
        digest = sha256(payload).hexdigest()
        prior = self.storage.index.execute(
            'SELECT dialog,cluster_id,digest,count FROM blocks WHERE block_id=?', (block_id,)
        ).fetchone()
        if prior is None:
            self.storage.append(dialog, block_id, cluster, values)
        elif prior != (dialog, cluster, digest, len(values)):
            raise ValueError('publication_write_conflict')
        else:
            # Retry can restore the local payload, but never rewrites history.
            self.storage.restore_payload(block_id, payload)
            with self.storage.index:
                self.storage.index.execute('INSERT OR IGNORE INTO publication_jobs(block_id,size) VALUES(?,?)',
                                           (block_id, len(payload)))
        return {'block_id': block_id, 'digest': digest, 'state': 'local', 'consensus_committed': False}

    def _known(self):
        directory, journal = self.publication.directory, self.publication.journal
        with directory.lock, journal.lock:
            if journal.db.execute('SELECT pin FROM replica_trust').fetchone() != (directory.pin,):
                raise ValueError('placement_trust_changed')
            # Copy while holding the verified directory lock.
            return verified_manifests(directory)

    def reserve_many(self, block_ids):
        """Replicate locally staged pages, then admit all missing writes atomically."""
        if self.queue is None or not self.queue.content_bound:
            raise ValueError('content_bound_write_queue_required')
        if (not isinstance(block_ids, list) or not 1 <= len(block_ids) <= 4096 or
                any(not isinstance(block, str) or not block for block in block_ids) or
                len(set(block_ids)) != len(block_ids)):
            raise ValueError('invalid_storage_reservation_batch')
        rows = []
        for offset in range(0, len(block_ids), 512):
            selected = block_ids[offset:offset + 512]
            rows.extend(self.storage.index.execute('''SELECT b.block_id,b.cluster_id,b.digest,j.size
                FROM blocks b JOIN publication_jobs j ON j.block_id=b.block_id
                WHERE b.block_id IN (''' + ','.join('?' for _ in selected) + ')', selected).fetchall())
        if len(rows) != len(block_ids): raise ValueError('unknown_publication_reservation_block')
        self.publication.directory.refresh(self.publication.address)
        _, known = self._known()
        pending = [row for row in rows if known.get(row[1], {}).get('sizes', {}).get(row[2]) != row[3]]
        if len(pending) > 128:
            return {'state': 'blocked', 'error': 'write_batch_queue_capacity_exhausted'}
        for block, cluster, digest, size in pending:
            try: payload = canonical([value.hex() for value in self.storage.read(block)])
            except (FileNotFoundError, ValueError): payload = None
            if payload is not None and (len(payload) != size or sha256(payload).hexdigest() != digest):
                raise ValueError('publication_local_size_conflict')
            self.publication.journal._stage_digest(cluster, digest, payload)
        journal = self.publication.journal
        for cluster in sorted({row[1] for row in pending}): journal.run_batch(cluster, limit=64)
        with journal.lock:
            for _, cluster, digest, _ in pending:
                row = journal.db.execute('SELECT state FROM replica_jobs WHERE cluster=? AND digest=?', (cluster, digest)).fetchone()
                if row != ('replicated',): return {'state': 'waiting', 'error': 'write_batch_copies_incomplete'}
        requests = [{'cluster': cluster, 'block_token': sha256(canonical({
            'domain': 'sfera-mesh-storage-write-v1', 'block_id': block})).hexdigest(),
            'digest': digest, 'size': size} for block, cluster, digest, size in rows]
        return self.queue.reserve_many(requests)

    def step(self, cluster, *, limit=64):
        if not digest64(cluster) or type(limit) is not int or not 1 <= limit <= 64:
            raise ValueError('invalid_storage_publication_batch')
        rows = self.storage.index.execute('''SELECT b.block_id,b.digest,j.size FROM publication_jobs j
            JOIN blocks b ON b.block_id=j.block_id
            WHERE b.cluster_id=? AND j.state='pending' ORDER BY b.dialog,b.position LIMIT ?''', (cluster, limit)).fetchall()
        if not rows:
            if self.queue is not None: return {**self.queue.step(cluster,limit=limit),'indexed':0}
            return {'state': 'idle', 'error': None, 'indexed': 0}
        if self.queue is not None and self.queue.content_bound and any(block.startswith('recovery-page:') for block, _, _ in rows):
            # The ordinary message worker also drains this local publication
            # table before resuming the index controller. It must never turn
            # last tick's unreserved page generation into individual writes.
            from .write_queue import content_request_id
            directory = self.publication.directory
            directory.refresh(self.publication.address)
            with directory.lock:
                directory.anchor()
                state = directory.current['state']
                manifest = state.get('manifests', {}).get(cluster, {}).get('record', {}).get('body', {})
                known = dict(zip(manifest.get('digests', []), manifest.get('sizes') or []))
                for block, digest, size in rows:
                    if not block.startswith('recovery-page:') or known.get(digest) == size: continue
                    token = sha256(canonical({'domain': 'sfera-mesh-storage-write-v1', 'block_id': block})).hexdigest()
                    identity = content_request_id(directory.network, cluster, self.publication.journal.verifier.recipient, token, digest, size)
                    if identity not in state.get('write_queue', {}):
                        return {'state': 'waiting', 'error': 'atomic_page_reservation_required', 'indexed': 0}
        for block, digest, size in rows:
            if not digest64(digest) or type(size) is not int or not 1 <= size <= 262144:
                raise ValueError('invalid_publication_queue_entry')
            try:
                payload = canonical([value.hex() for value in self.storage.read(block)])
            except (FileNotFoundError, ValueError):
                payload = None
            if payload is not None and (len(payload) != size or sha256(payload).hexdigest() != digest):
                raise ValueError('publication_local_size_conflict')
            self.publication.journal._stage_digest(cluster, digest, payload)
        if self.queue is None:
            status = self.publication.step(cluster, limit=limit)
        else:
            # Ciphertext must be on all three holders before they consent to
            # replication of the immutable request by the validator committee.
            self.publication.journal.run_batch(cluster,limit=limit)
            requests = [{'cluster': cluster, 'block_token': sha256(canonical({
                'domain': 'sfera-mesh-storage-write-v1', 'block_id': block})).hexdigest(),
                'digest': digest, 'size': size} for block, digest, size in rows]
            ready = self.queue.ready_many(requests) if hasattr(self.queue, 'ready_many') else [False] * len(rows)
            for request, admitted in zip(requests, ready):
                if admitted: continue
                status = self.queue.submit(cluster,request['block_token'],request['digest'],request['size'])
                if status['state'] != 'queued': return {**status,'indexed':0}
            status = self.queue.step(cluster,limit=limit)
        _, known = self._known()
        sizes = known.get(cluster, {}).get('sizes', {})
        indexed = [(block,) for block, digest, size in rows if sizes.get(digest) == size]
        with self.storage.index:
            self.storage.index.executemany("UPDATE publication_jobs SET state='indexed' WHERE block_id=?", indexed)
        # Restore missing/corrupt local bytes from the journal only after its
        # source/readback checks, independently of consensus inclusion.
        for block, digest, _ in rows:
            with self.publication.journal.lock:
                job = self.publication.journal.db.execute('SELECT payload FROM replica_jobs WHERE cluster=? AND digest=?',
                                                         (cluster, digest)).fetchone()
            if job and job[0] is not None and sha256(job[0]).hexdigest() == digest:
                self.storage.restore_payload(block, job[0])
        return {**status, 'indexed': len(indexed)}

    def status(self, block_id):
        result = self.status_many([block_id])
        if block_id not in result:
            raise KeyError('unknown_publication_block')
        return result[block_id]

    def status_many(self, block_ids):
        if not isinstance(block_ids, (list, tuple)) or not 1 <= len(block_ids) <= 512 or any(not isinstance(value, str) or not value for value in block_ids):
            raise ValueError('invalid_publication_status_batch')
        rows = self.storage.index.execute('''SELECT b.block_id,b.cluster_id,b.digest,j.size FROM blocks b
            JOIN publication_jobs j ON j.block_id=b.block_id WHERE b.block_id IN ('''
            + ','.join('?' for _ in block_ids) + ')', block_ids).fetchall()
        if not rows:
            return {}
        self.publication.directory.refresh(self.publication.address)
        anchor, known = self._known()
        result = {}
        for block_id, cluster, digest, size in rows:
            head = known.get(cluster, {})
            committed = head.get('sizes', {}).get(digest) == size
            receipt = {'block_id': block_id, 'cluster': cluster, 'digest': digest,
                       'state': 'confirmed' if committed else 'pending', 'consensus_committed': committed}
            if committed:
                receipt.update(manifest_hash=head['digest'], manifest_version=head['version'], finality=anchor)
            result[block_id] = receipt
        return result

    def confirm_sizes(self, cluster, sizes):
        """One fresh verified manifest covering the exact requested byte lengths."""
        return self.confirm_clusters({cluster: sizes})[cluster]

    def confirm_clusters(self, queries):
        """All requested clusters are checked against the same verified snapshot."""
        validate_size_queries(queries)
        self.publication.directory.refresh(self.publication.address)
        anchor, known = self._known()
        return check_sizes(anchor, known, queries)
