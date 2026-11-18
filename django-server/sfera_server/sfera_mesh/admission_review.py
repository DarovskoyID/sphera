"""Independent evidence reviews before an admission approval can be signed.

Authority ownership is an externally pinned deployment input, never supplied
by a candidate. These signatures attest a human review, not physical truth.
"""
from collections import Counter
from hashlib import sha256

from .admission import _signature, verify_application, approval
from .directory import digest64
from .storage import canonical


def validate_operator_set(operators):
    if not isinstance(operators, list) or not 4 <= len(operators) <= 16:
        raise ValueError('independent_operator_set_required')
    for item in operators:
        if (not isinstance(item, dict) or set(item) != {'operator', 'failure_domain', 'provider'} or
                not all(digest64(value) for value in item.values())):
            raise ValueError('invalid_operator_independence')
    if len({item['operator'] for item in operators}) != len(operators):
        raise ValueError('one_vote_per_controlling_operator')
    for field in ('failure_domain', 'provider'):
        if 3 * max(Counter(item[field] for item in operators).values()) >= len(operators):
            raise ValueError('correlated_failure_quorum_risk')


def review_body(request, network, genesis, policy, *, now):
    digest = verify_application(request, network, genesis, policy, now=now)
    return {'domain': 'sfera-mesh-independence-review-v1', 'network': network,
        'genesis': genesis, 'policy': policy, 'application': digest,
        'operator': request['body']['operator'], 'evidence': request['body']['evidence'],
        'issued_at': now, 'expires_at': request['body']['expires_at'],
        'verdict': 'independent'}


def verify_review(record, request, network, genesis, policy, authorities, candidate, *, now):
    """Require two disinterested independently owned pinned assessor keys."""
    verify_application(request, network, genesis, policy, now=now)
    if (not isinstance(authorities, dict) or not 4 <= len(authorities) <= 16 or
            any(not digest64(public) for public in authorities)):
        raise ValueError('pinned_review_authorities_required')
    validate_operator_set(list(authorities.values()))
    if (not isinstance(candidate, dict) or set(candidate) != {'operator', 'failure_domain', 'provider'} or
            not all(digest64(value) for value in candidate.values()) or
            candidate['operator'] != request['body']['operator']):
        raise ValueError('review_candidate_context_mismatch')
    if not isinstance(record, dict) or set(record) != {'body', 'votes'} or len(canonical(record)) > 16384:
        raise ValueError('invalid_independence_review')
    body = record['body']
    if not isinstance(body, dict) or type(body.get('issued_at')) is not int:
        raise ValueError('invalid_independence_review')
    expected = review_body(request, network, genesis, policy, now=body['issued_at'])
    # Bind the checked infrastructure to the review as well as to the request.
    expected['infrastructure'] = candidate
    if body != expected or not body['issued_at'] <= now < body['expires_at']:
        raise ValueError('independence_review_context_mismatch')
    votes = record['votes']
    if not isinstance(votes, list) or not 2 <= len(votes) <= len(authorities):
        raise ValueError('two_independent_reviewers_required')
    prior, owners = '', set()
    for vote in votes:
        if (not isinstance(vote, dict) or set(vote) != {'public_key', 'signature'} or
                not digest64(vote['public_key']) or vote['public_key'] <= prior or
                vote['public_key'] not in authorities):
            raise ValueError('distinct_pinned_reviewers_required')
        owner = authorities[vote['public_key']]
        if (owner['operator'] == candidate['operator'] or owner['operator'] in owners or
                owner['failure_domain'] == candidate['failure_domain']):
            raise ValueError('interested_admission_reviewer')
        _signature(vote['public_key'], vote['signature'], body)
        owners.add(owner['operator'])
        prior = vote['public_key']
    return sha256(canonical(record)).hexdigest()


def reviewed_approval(request, review, network, genesis, policy, committee, authorities,
                      candidate, keys, *, now, version=1, previous='0' * 64):
    if set(committee.values()) != set(authorities):
        raise ValueError('review_authorities_must_match_pinned_assessors')
    verify_review(review, request, network, genesis, policy, authorities, candidate, now=now)
    return approval(request, network, genesis, policy, committee, keys,
                    now=now, version=version, previous=previous)
