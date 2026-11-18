"""Verified queued writes reserve unique slots against every manifest writer."""
from .directory import digest64

MANIFEST_SLOTS = 512


def check_write_capacity(state, cluster, additions=None):
    if not digest64(cluster) or (additions is not None and not isinstance(additions, dict)):
        raise ValueError('invalid_write_capacity_query')
    values = {}
    def include(digest, size):
        if not digest64(digest) or type(size) is not int or not 0 <= size <= 262144:
            raise ValueError('invalid_write_capacity_query')
        if values.get(digest, 0) and size and values[digest] != size:
            raise ValueError('queued_ciphertext_size_conflict')
        if digest not in values or size: values[digest] = size
    head = state.get('manifests', {}).get(cluster)
    if head:
        body = head['record']['body']
        for index, digest in enumerate(body['digests']):
            include(digest, body['sizes'][index] if 'sizes' in body else 0)
    for head in state.get('write_queue', {}).values():
        body = head['record']['body']
        if body['cluster'] == cluster: include(body['digest'], body['size'])
    for digest, size in (additions or {}).items(): include(digest, size)
    if len(values) > MANIFEST_SLOTS: raise ValueError('write_manifest_capacity_exhausted')
