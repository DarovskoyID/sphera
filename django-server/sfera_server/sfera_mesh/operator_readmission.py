"""Lost-key recovery via terminal revocation followed by ordinary new admission.

No signature from the lost key and no inheritance of votes, licenses or ACLs.
The ordinary publisher persists each packet and verifies consensus inclusion.
"""
from hashlib import sha256
import json

from .admission import verify_application, verify_approval
from .admission_consensus import admission_packet, admission_snapshot
from .admission_revocation import revocation, verify_revocation
from .directory import digest64
from .storage import canonical


def recovery_reason(head, request):
    return sha256(canonical({'domain': 'sfera-mesh-operator-readmission-v1',
        'genesis': request['body']['genesis'], 'policy': request['body']['policy'],
        'previous': head['digest'], 'old_node': head['application']['body']['node_id'],
        'new_node': request['body']['node_id'], 'operator': request['body']['operator']})).hexdigest()


def prepare_readmission(head, request, approved, network, genesis, policy, committee,
                        keys, *, now, revoked=None):
    """Keys belong to assessors; the old operator secret is deliberately absent.

    Reuse the confirmed revocation with renewed short-lived new-key approvals
    if a crash or an outage exhausted the first approval's lifetime.
    """
    verify_application(request, network, genesis, policy, now=now)
    verify_approval(approved, request, network, genesis, policy, committee, now=now)
    old = head['application']['body']
    if old['operator'] != request['body']['operator'] or old['node_id'] == request['body']['node_id']:
        raise ValueError('readmission_requires_same_operator_new_identity')
    reason = recovery_reason(head, request)
    if revoked is None:
        revoked = revocation(head, network, genesis, policy, committee, keys, reason, now=now)
    # A persisted terminal revocation is checked at its original signing time;
    # this does not renew its lifetime or bypass the publisher's live checks.
    verify_revocation(revoked, head, network, genesis, policy, committee,
                      now=revoked['body']['issued_at'])
    if revoked['body']['reason'] != reason:
        raise ValueError('readmission_revocation_target_mismatch')
    return json.loads(canonical({'domain': 'sfera-mesh-operator-readmission-plan-v1',
        'network': network, 'genesis': genesis, 'policy': policy,
        'old_node': old['node_id'], 'new_node': request['body']['node_id'],
        'revoke': admission_packet(network, 'revoke', revocation=revoked),
        'admit': admission_packet(network, 'approve', application=request, approval=approved)}))


def step_readmission(publisher, plan):
    """Advance at most one packet; never admit while old revocation is pending."""
    if (not isinstance(plan, dict) or set(plan) != {'domain', 'network', 'genesis', 'policy',
            'old_node', 'new_node', 'revoke', 'admit'} or len(canonical(plan)) > 32768 or
            plan['domain'] != 'sfera-mesh-operator-readmission-plan-v1' or
            not all(digest64(plan[field]) for field in ('genesis', 'policy', 'old_node', 'new_node'))):
        raise ValueError('invalid_operator_readmission_plan')
    directory = publisher.directory
    if (plan['network'], plan['genesis']) != (directory.network, directory.pin):
        raise ValueError('readmission_context_mismatch')
    if (not isinstance(plan['revoke'], dict) or not isinstance(plan['admit'], dict) or
            set(plan['revoke']) != {'body', 'revocation'} or
            set(plan['admit']) != {'body', 'application', 'approval'}):
        raise ValueError('invalid_operator_readmission_packets')
    if (plan['revoke'] != admission_packet(directory.network, 'revoke', revocation=plan['revoke']['revocation']) or
            plan['admit'] != admission_packet(directory.network, 'approve',
                application=plan['admit']['application'], approval=plan['admit']['approval'])):
        raise ValueError('invalid_operator_readmission_packets')
    directory.refresh(publisher.address)
    with directory.lock:
        directory.anchor()
        state = json.loads(canonical(directory.current['state']))
    if state.get('admission_policy') != plan['policy']:
        raise ValueError('readmission_policy_mismatch')
    registry = admission_snapshot(state, directory.network, directory.pin, publisher.committee)
    if registry is None:
        raise ValueError('readmission_old_admission_required')
    try:
        history = registry.history(plan['old_node'])
        if not history:
            raise ValueError('readmission_old_admission_required')
        revoked = plan['revoke']['revocation']
        old_revoked = history[-1]['approval']['body']['domain'] == 'sfera-mesh-admission-revocation-lab-v1'
        original = history[-2] if old_revoked and len(history) > 1 else history[-1]
        request, approved = plan['admit']['application'], plan['admit']['approval']
        if (request['body']['node_id'] != plan['new_node'] or
                request['body']['operator'] != original['application']['body']['operator'] or
                plan['old_node'] == plan['new_node'] or
                revoked['body']['reason'] != recovery_reason(original, request)):
            raise ValueError('readmission_target_mismatch')
        verify_revocation(revoked, original, directory.network, directory.pin, plan['policy'],
                          publisher.committee, now=revoked['body']['issued_at'])
        target = registry.history(plan['new_node'])
        if old_revoked:
            if history[-1]['approval'] != revoked:
                raise ValueError('readmission_revocation_conflict')
            if target:
                if target[0]['application'] != request or target[0]['approval'] != approved:
                    raise ValueError('readmission_target_already_used')
                # A later revocation must never be reported as a recovered live node.
                if registry.head(plan['new_node'], now=state['block_time'])['revoked']:
                    raise ValueError('readmission_target_revoked')
                return {'state': 'confirmed', 'old_node': plan['old_node'],
                    'new_node': plan['new_node'], 'roles_inherited': False,
                    'document_live': registry.head(plan['new_node'], now=state['block_time'])['document_live']}
            # Check renewed approval before sending it; the ordinary publisher
            # independently checks it against its own refreshed snapshot too.
            verify_approval(approved, request, directory.network, directory.pin,
                plan['policy'], publisher.committee, now=state['block_time'])
            phase, packet = 'admitting', plan['admit']
        else:
            if target:
                raise ValueError('readmission_target_already_used')
            verify_approval(approved, request, directory.network, directory.pin,
                plan['policy'], publisher.committee, now=state['block_time'])
            phase, packet = 'revoking', plan['revoke']
    finally:
        registry.close()
    result = publisher.step(packet)
    return {'state': phase, 'publication': result, 'roles_inherited': False}
