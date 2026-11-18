"""Conservative lending evidence from an already verified consensus snapshot.

Block timestamps cannot order transactions within one block. Ambiguous or
legacy histories never authorize a return; this module does not free a slot.
"""


def borrowed_memberships(state):
    histories = state.get('placement_history', {})
    active = {}
    for cluster, head in state.get('placements', {}).items():
        history = histories.get(cluster)
        if not history or history[-1] != head:
            raise ValueError('placement_history_required')
        # Retain the start of the current uninterrupted membership, not the
        # first appearance: leaving and rejoining resets its provenance.
        starts = {}
        previous = set()
        for item in history:
            members = set(item['record']['body']['members'])
            starts = {node: starts[node] for node in members & previous}
            for node in members - previous:
                starts[node] = item
            previous = members
        for node, entry in starts.items():
            active.setdefault(node, []).append((cluster, entry))
    result = []
    for node, entries in active.items():
        if len(entries) != 2:
            continue
        times = [entry.get('accepted_at') for _, entry in entries]
        if any(type(at) is not int or at <= 0 for at in times) or times[0] == times[1]:
            continue
        home, loan = sorted(entries, key=lambda pair: pair[1]['accepted_at'])
        if loan[1]['record']['body']['epoch'] == 1:
            continue  # A second initial allocation is not a replacement loan.
        result.append({'node_id': node, 'home_cluster': home[0],
                       'borrowed_cluster': loan[0],
                       'home_entry_hash': home[1]['digest'],
                       'borrowed_entry_hash': loan[1]['digest']})
    return sorted(result, key=lambda row: (row['borrowed_cluster'], row['node_id']))
