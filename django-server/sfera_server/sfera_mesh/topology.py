"""Deterministic placement policy; input grants must be verified by the caller."""
from dataclasses import dataclass, replace
from itertools import combinations
import time


@dataclass(frozen=True)
class Candidate:
    node_id: str
    failure_domain: str
    paid_modules: frozenset[str]
    memberships: frozenset[str] = frozenset()
    capacity_ok: bool = True
    grant_verified: bool = False
    grant_expires_at: int | None = None


def choose_cluster(candidates, *, now=None):
    current = int(time.time() if now is None else now)
    eligible = [n for n in candidates if n.capacity_ok and n.grant_verified and (n.grant_expires_at is None or n.grant_expires_at > current) and len(n.memberships) < 2]
    choices = []
    for group in combinations(eligible, 3):
        if len({n.node_id for n in group}) != 3 or len({n.failure_domain for n in group}) != 3:
            continue
        counts = [len(n.paid_modules) for n in group]
        mismatch = sum(len(a.paid_modules ^ b.paid_modules) for a, b in combinations(group, 2))
        choices.append(((max(counts) - min(counts), mismatch, tuple(sorted(n.node_id for n in group))), group))
    return tuple(sorted(min(choices, key=lambda x: x[0])[1], key=lambda n: n.node_id)) if choices else ()


def choose_replacement(survivors, candidates, cluster_id):
    if len(survivors) != 2 or len({n.node_id for n in survivors}) != 2:
        raise ValueError("quorum_required")
    options = []
    for node in candidates:
        if cluster_id in node.memberships:
            continue
        group = choose_cluster([*[replace(n, memberships=frozenset()) for n in survivors], node])
        if len(group) == 3:
            counts = [len(n.paid_modules) for n in group]
            mismatch = sum(len(a.paid_modules ^ b.paid_modules) for a, b in combinations(group, 2))
            options.append(((max(counts) - min(counts), mismatch, len(node.memberships), node.node_id), node))
    return min(options, key=lambda x: x[0])[1] if options else None


def module_available(entry_paid, entry_installed, module_id, acl_allowed):
    # No neighbour grants or account-wide entitlement participates in this decision.
    return acl_allowed and module_id in entry_paid and module_id in entry_installed
