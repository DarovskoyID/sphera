"""Independent, short-lived fixed-genesis failure observations and revocations."""
from hashlib import sha256
import time
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .directory import digest64
from .resources import validate_resource_body
from .storage import canonical


def validate_observations(observations, directory, bindings, *, now=None):
    now = int(time.time() if now is None else now)
    if not isinstance(observations,list) or len(observations)!=3 or len(canonical(observations))>16384:
        raise ValueError('three_independent_observations_required')
    assessors, observers, contexts = set(), set(), set()
    starts, ends, deadlines = [], [], []
    with directory.lock:
        directory.anchor(now=now)
        for record in observations:
            if not isinstance(record,dict) or set(record)!={'body','public_key','signature'} or not digest64(record['public_key']):
                raise ValueError('invalid_failure_observation')
            body=record['body']
            fields={'domain','network','cluster','placement_hash','node_id','candidate_hash','observer','failure_since','observed_at','failures','healthy_survivors'}
            if not isinstance(body,dict) or set(body)!=fields or body['domain']!='sfera-mesh-failure-observation-v1' or body['network']!=directory.network or any(not digest64(body[field]) for field in ('cluster','placement_hash','node_id','candidate_hash','observer')):
                raise ValueError('invalid_failure_context')
            public=bytes.fromhex(record['public_key'])
            assessor=sha256(public).hexdigest()
            try:
                signature=bytes.fromhex(record['signature'])
                if directory.placement_assessors.get(assessor)!=record['public_key'] or len(signature)!=64 or signature.hex()!=record['signature']:
                    raise ValueError('unpinned_failure_assessor')
                Ed25519PublicKey.from_public_bytes(public).verify(signature,canonical(body))
            except (ValueError,TypeError,InvalidSignature) as exc:
                raise ValueError('invalid_failure_signature') from exc
            if bindings.get(assessor)!=body['observer'] or assessor in assessors or body['observer'] in observers or body['observer']==body['node_id']:
                raise ValueError('independent_pinned_observers_required')
            if any(type(body[field]) is not int for field in ('failure_since','observed_at','failures')) or not 3<=body['failures']<=10 or not 0<=body['failure_since']<=body['observed_at']-10 or not now-15<body['observed_at']<=now+5:
                raise ValueError('stale_or_insufficient_failure_window')
            placement=directory.placement(body['cluster'])
            members=placement['record']['body']['members']
            candidate=directory.current['state'].get('candidates',{}).get(body['node_id'])
            survivors=sorted(identity for identity in members if identity!=body['node_id'])
            if placement['record_hash']!=body['placement_hash'] or body['node_id'] not in members or body['healthy_survivors']!=survivors or candidate is None or candidate['digest']!=body['candidate_hash']:
                raise ValueError('failure_snapshot_changed')
            assessors.add(assessor); observers.add(body['observer'])
            contexts.add((body['cluster'],body['placement_hash'],body['node_id'],body['candidate_hash']))
            starts.append(body['failure_since']); ends.append(body['observed_at']); deadlines.append(body['observed_at']+15)
        if len(contexts)!=1 or min(ends)-max(starts)<10:
            raise ValueError('failure_observation_windows_do_not_overlap')
        cluster,placement_hash,identity,candidate_hash=next(iter(contexts))
        return {'cluster':cluster,'placement_hash':placement_hash,'node_id':identity,'candidate_hash':candidate_hash,'expires_at':min(deadlines)}


class FailureObserver:
    def __init__(self, assessor_key, health, directory, bindings):
        public=assessor_key.public_key().public_bytes_raw()
        self.assessor=sha256(public).hexdigest()
        self.key,self.health,self.directory,self.bindings=assessor_key,health,directory,dict(bindings)
        if directory.placement_assessors.get(self.assessor)!=public.hex() or bindings.get(self.assessor)!=health.verifier.recipient or health.verifier.network!=directory.network:
            raise ValueError('pinned_failure_observer_required')

    def observe(self,payload):
        if not isinstance(payload,dict) or set(payload)!={'cluster'} or not digest64(payload['cluster']):
            raise ValueError('invalid_failure_request')
        with self.directory.lock:
            self.directory.anchor()
            placement=self.directory.placement(payload['cluster'])
            advisory=self.health.advisory(self.directory,payload['cluster'])
            if not advisory['can_request_consents']:
                raise ValueError('local_failure_quorum_not_observed')
            identity=advisory['unreachable_from_observer'][0]
            status=self.health.status(identity)
            candidate=self.directory.current['state'].get('candidates',{}).get(identity)
            if candidate is None or self.health.verifier.recipient==identity:
                raise ValueError('failure_candidate_unavailable')
            # Ceil since / floor end cannot exaggerate the observed interval.
            import math
            body={'domain':'sfera-mesh-failure-observation-v1','network':self.directory.network,'cluster':payload['cluster'],'placement_hash':placement['record_hash'],'node_id':identity,'candidate_hash':candidate['digest'],'observer':self.health.verifier.recipient,'failure_since':math.ceil(status['failure_since']),'observed_at':int(status['last_check']),'failures':status['failures'],'healthy_survivors':sorted(advisory['healthy_survivors'])}
            if body['observed_at']-body['failure_since']<10:
                raise ValueError('failure_window_too_short')
            return {'body':body,'public_key':self.key.public_key().public_bytes_raw().hex(),'signature':self.key.sign(canonical(body)).hex()}

    def consent(self,payload):
        if not isinstance(payload,dict) or set(payload)!={'body','observations'}:
            raise ValueError('invalid_failure_consent_request')
        body=validate_resource_body(payload['body'],self.directory.network)
        with self.directory.lock:
            evidence=validate_observations(payload['observations'],self.directory,self.bindings)
            own=self.observe({'cluster':evidence['cluster']})
            old_own=next((record for record in payload['observations'] if record['public_key']==own['public_key']),None)
            # Local recovery or a changed target vetoes a previously signed report.
            if own['body']['node_id']!=evidence['node_id'] or old_own is None or own['body']['failure_since']!=old_own['body']['failure_since'] or own['body']['observed_at']<old_own['body']['observed_at']:
                raise ValueError('own_current_failure_observation_required')
            state=self.directory.current['state']
            old=state.get('resources',{}).get(evidence['node_id'])
            candidate=state['candidates'][evidence['node_id']]
            now=int(time.time())
            if old is None or body['node_id']!=evidence['node_id'] or body['candidate_hash']!=evidence['candidate_hash'] or body['capacity_slots']!=0 or body['failure_domain']!=old['record']['body']['failure_domain'] or body['version']!=old['record']['body']['version']+1 or body['previous']!=old['digest'] or not now-5<=body['issued_at']<=now+5 or not now<body['expires_at']<=min(now+15,evidence['expires_at'],candidate['record']['body']['license']['claims']['expires_at']):
                raise ValueError('failure_revocation_changed_or_expired')
            consent={'public_key':self.key.public_key().public_bytes_raw().hex(),'signature':self.key.sign(canonical(body)).hex()}
            return {'body_hash':sha256(canonical(body)).hexdigest(),'consent':consent}
