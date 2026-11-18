"""Bounded read queries against one independently verified manifest snapshot."""
from .directory import digest64


def validate_size_queries(queries):
    if (not isinstance(queries, dict) or not 1 <= len(queries) <= 64 or
            any(not digest64(cluster) or not isinstance(sizes, dict) or not 1 <= len(sizes) <= 512 or
                any(not digest64(digest) or type(size) is not int or not 1 <= size <= 262144 for digest, size in sizes.items())
                for cluster, sizes in queries.items()) or sum(len(sizes) for sizes in queries.values()) > 512):
        raise ValueError('invalid_publication_size_query')


def verified_manifests(directory):
    with directory.lock:
        anchor = directory.anchor()
        known = {cluster: {'digest': head['digest'], 'version': head['record']['body']['version'],
                          'sizes': dict(zip(head['record']['body']['digests'], head['record']['body'].get('sizes', [])))}
                 for cluster, head in directory.current['state'].get('manifests', {}).items()}
        return anchor, known


def check_sizes(anchor, known, queries):
    result = {}
    for cluster, sizes in queries.items():
        head = known.get(cluster, {})
        if any(head.get('sizes', {}).get(digest) != size for digest, size in sizes.items()):
            raise ValueError('publication_blocks_not_confirmed')
        result[cluster] = {'manifest_hash': head['digest'], 'manifest_version': head['version'], 'finality': anchor}
    return result
