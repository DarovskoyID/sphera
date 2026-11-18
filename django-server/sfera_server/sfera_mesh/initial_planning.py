"""Bounded exact laboratory planning, not a consensus batch transaction."""
from itertools import combinations
from hashlib import sha256
import time
from .storage import canonical
from .directory import digest64


def validate_initial_batches(state,network):
    receipts=state.get('initial_batches',{})
    if not isinstance(receipts,dict) or len(receipts)>128:
        raise ValueError('invalid_initial_batch_receipts')
    seen=set()
    for digest,receipt in receipts.items():
        if not digest64(digest) or not isinstance(receipt,dict) or set(receipt)!={'body','clusters','accepted_at'} or not state.get('placement_assessors'):
            raise ValueError('invalid_initial_batch_receipt')
        body=receipt['body']; at=receipt['accepted_at']; clusters=receipt['clusters']
        if not isinstance(body,dict) or set(body)!={'domain','network','pool_hash','placements_hash'} or body['domain']!='sfera-mesh-initial-batch-v1' or body['network']!=network or not digest64(body['pool_hash']) or type(at) is not int or not 0<at<=state.get('block_time',0) or not isinstance(clusters,list) or not 1<=len(clusters)<=4:
            raise ValueError('invalid_initial_batch_context')
        records=[]; members=set(); previous=''
        for cluster in clusters:
            if not digest64(cluster) or cluster in seen: raise ValueError('invalid_initial_batch_origin')
            seen.add(cluster)
            history=state.get('placement_history',{}).get(cluster)
            if not history or history[0].get('accepted_at')!=at: raise ValueError('invalid_initial_batch_origin')
            record=history[0]['record']; placement=record['body']
            group=placement['members']
            if placement['domain']!='sfera-mesh-placement-v2' or placement['epoch']!=1 or len(group)!=3 or group[0]<=previous or members.intersection(group):
                raise ValueError('invalid_initial_batch_ordering')
            members.update(group); previous=group[0]; records.append(record)
        if body['placements_hash']!=sha256(canonical(records)).hexdigest() or digest!=sha256(canonical({'body':body,'placements':records})).hexdigest():
            raise ValueError('initial_batch_receipt_hash_mismatch')


def initial_candidates(candidates, now):
    candidates=list(candidates)
    if len({node.node_id for node in candidates})!=len(candidates):
        raise ValueError('duplicate_initial_candidate')
    eligible=tuple(sorted((node for node in candidates if node.capacity_ok and node.grant_verified
                    and type(node.grant_expires_at) is int and node.grant_expires_at>now
                    and not node.memberships),key=lambda node:node.node_id))
    if len(eligible)>64: raise ValueError('initial_planning_laboratory_limit')
    return eligible


def initial_pool_hash(candidates,state,*,now):
    return sha256(canonical([{'node_id':node.node_id,'candidate_hash':state['candidates'][node.node_id]['digest'],
                              'resource_hash':state['resources'][node.node_id]['digest']}
                             for node in initial_candidates(candidates,now)])).hexdigest()


def initial_batch(plan,placements):
    from .placements import validate_placement
    if not plan.get('complete') or plan.get('domain')!='sfera-mesh-initial-plan-lab-v1' or len(placements)!=plan['requested_count']:
        raise ValueError('complete_initial_plan_required')
    groups=[]
    for record in placements:
        body,_=validate_placement(record,plan['network'])
        if body['domain']!='sfera-mesh-placement-v2' or body['epoch']!=1:
            raise ValueError('initial_licensed_placements_required')
        groups.append(body['members'])
    if groups!=plan['groups']: raise ValueError('initial_batch_plan_mismatch')
    return {'body':{'domain':'sfera-mesh-initial-batch-v1','network':plan['network'],
                    'pool_hash':plan['pool_hash'],'placements_hash':sha256(canonical(placements)).hexdigest()},
            'placements':placements}


def plan_initial_clusters(candidates, count, *, now=None, max_states=100000, network=None, existing_clusters=()):
    """Jointly rank disjoint primary triples of currently unassigned nodes.

    Minimize summed module-count spread, then summed module-set mismatch,
    then canonical member IDs. Search exhaustion never returns a partial plan.
    Existing memberships and temporary borrowing use separate protocols.
    """
    if type(count) is not int or not 1 <= count <= 4 or type(max_states) is not int or not 1 <= max_states <= 1000000:
        raise ValueError('invalid_initial_planning_bounds')
    current = int(time.time() if now is None else now)
    existing_clusters=frozenset(existing_clusters)
    if existing_clusters and (not isinstance(network,str) or not network):
        raise ValueError('initial_planning_network_required')
    eligible = initial_candidates(candidates,current)
    if len(eligible) < count * 3:
        return ()
    options = []
    for indices in combinations(range(len(eligible)), 3):
        group = tuple(eligible[i] for i in indices)
        if len({node.failure_domain for node in group}) != 3:
            continue
        if existing_clusters:
            from .placements import cluster_id
            if cluster_id(network,[node.node_id for node in group]) in existing_clusters:
                continue
        counts = [len(node.paid_modules) for node in group]
        score = (max(counts)-min(counts), sum(len(a.paid_modules ^ b.paid_modules) for a,b in combinations(group,2)))
        if count == 1 and score == (0,0):
            return (group,)
        mask = sum(1 << i for i in indices)
        options.append((group,mask,score))
    best, result, states = None, (), 0

    def search(start, used, chosen, spread, mismatch):
        nonlocal best, result, states
        states += 1
        if states > max_states:
            raise ValueError('initial_planning_search_budget_exceeded')
        remaining = count-len(chosen)
        if not remaining:
            score = (spread,mismatch,tuple(tuple(node.node_id for node in group) for group in chosen))
            if best is None or score < best:
                best, result = score, tuple(chosen)
            return
        if len(eligible)-used.bit_count() < remaining*3:
            return
        if best is not None and (spread > best[0] or (spread == best[0] and mismatch > best[1])):
            return
        for index in range(start,len(options)):
            # DFS enumerates canonical ID tuples. The first zero/zero plan
            # is the lexicographically first global optimum; scores are >=0.
            if best is not None and best[:2] == (0,0): return
            group,mask,score = options[index]
            if not used & mask:
                search(index+1,used|mask,chosen+[group],spread+score[0],mismatch+score[1])

    search(0,0,[],0,0)
    return result
