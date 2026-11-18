"""Preflight immutable page batches against confirmed and pending manifest slots.

This is admission advice at a verified snapshot, not a consensus reservation.
Other writers can consume slots afterwards; prepared bytes must never be rebased.
"""
from sfera_mesh.directory import digest64
from sfera_mesh.write_capacity import MANIFEST_SLOTS




def page_occupancy(writer, state, clusters):
    occupied = {cluster: set() for cluster in clusters}

    def include(cluster, digest):
        if cluster in occupied:
            if not digest64(digest): raise ValueError('invalid_paged_capacity_digest')
            occupied[cluster].add(digest)

    for cluster in clusters:
        head = state.get('manifests', {}).get(cluster)
        if head:
            for digest in head['record']['body']['digests']: include(cluster, digest)
    for head in state.get('write_queue', {}).values():
        body = head['record']['body']
        include(body['cluster'], body['digest'])
    # The normal writer has both journals. Lightweight adapters may have no
    # local queue; their verified consensus snapshot is still counted above.
    storage = getattr(writer, 'storage', None)
    if storage is not None:
        for cluster in clusters:
            rows = storage.index.execute('''SELECT b.digest FROM blocks b
                JOIN publication_jobs j ON j.block_id=b.block_id
                WHERE b.cluster_id=? AND j.state='pending' ''', (cluster,))
            for (digest,) in rows: include(cluster, digest)
    journal = writer.publication.journal
    if getattr(journal, 'db', None) is not None:
        with journal.lock:
            for cluster in clusters:
                # Replicated bytes can still be waiting for manifest inclusion.
                for (digest,) in journal.db.execute('SELECT digest FROM replica_jobs WHERE cluster=?', (cluster,)):
                    include(cluster, digest)
    return occupied


def page_capacity(writer, state, blocks):
    clusters = {cluster for cluster, _ in blocks}
    occupied = page_occupancy(writer, state, clusters)
    exhausted = []
    for cluster in sorted(clusters):
        planned = {digest for target, digest in blocks if target == cluster}
        needed = len(planned - occupied[cluster])
        if needed and len(occupied[cluster]) + needed > MANIFEST_SLOTS:
            exhausted.append({'cluster': cluster, 'occupied': len(occupied[cluster]),
                'additional': needed, 'limit': MANIFEST_SLOTS})
    return exhausted
