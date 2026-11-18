"""Durable fixed-genesis lab replacement: quorum assessment -> consent -> repair."""
import base64
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import threading
import time
from urllib.error import HTTPError
from .consensus_directory import ConsensusDirectory, validate_address, rpc
from .directory import digest64
from .identity import node_id
from .placements import consent_licensed_placement, validate_placement
from .refresh_lock import RefreshLock
from .resources import assessed_checks
from .storage import canonical
from .topology import choose_replacement
from .transport import exchange
from .readiness import base_proposal, readiness_proof, validate_readiness
from .membership_origins import borrowed_memberships


def reservation_license_expired(proposal,block_time):
    """Only an irreversible chain clock can expire the exact reserved packet.

    The reservation owner hashes the whole proposal, whose documents were
    checked when reserving. Changing a deadline cannot cancel that owner.
    """
    documents=proposal.get('licenses')
    if type(block_time) is not int or not isinstance(documents,list) or len(documents)!=3:
        return False
    if proposal.get('body',{}).get('licenses_hash')!=sha256(canonical(documents)).hexdigest():
        return False
    deadlines=[document.get('claims',{}).get('expires_at') if isinstance(document,dict) and isinstance(document.get('claims'),dict) else None for document in documents]
    return all(type(deadline) is int and 0<deadline<=2**63-1 for deadline in deadlines) and block_time>=min(deadlines)


def replacement_proposal(directory, cluster):
    """Quorum-assessed failure, or a healthy history-proven temporary loan."""
    with directory.lock:
        directory.anchor()
        if not directory.placement_assessors:
            raise ValueError('quorum_placement_policy_required')
        confirmed = directory.placement(cluster)
        current = confirmed['record']['body']
        state = directory.current['state']
        checks = assessed_checks(state, now=int(time.time()), cluster=cluster)
        unfit = [identity for identity in current['members'] if identity in checks and not checks[identity][1]]
        if len(unfit) > 1:
            raise ValueError('one_quorum_assessed_unfit_member_required')
        profiles = directory.placement_candidates(cluster=cluster)
        by_id = {profile.node_id:profile for profile in profiles}
        if not unfit:
            # Never turn missing/stale assessments into a planned departure.
            if any(identity not in by_id or not by_id[identity].capacity_ok for identity in current['members']):
                raise ValueError('one_quorum_assessed_unfit_member_required')
            if cluster not in state.get('manifests', {}):
                raise ValueError('one_quorum_assessed_unfit_member_required')
            for loan in borrowed_memberships(state):
                if loan['borrowed_cluster'] != cluster:
                    continue
                survivors = [by_id[identity] for identity in current['members'] if identity != loan['node_id']]
                free = [profile for profile in profiles if not profile.memberships]
                if choose_replacement(survivors, free, cluster) is not None:
                    unfit = [loan['node_id']]
                    break
            if not unfit:
                raise ValueError('one_quorum_assessed_unfit_member_required')
            options = [profile for profile in profiles if not profile.memberships]
        else:
            options = [profile for profile in profiles if profile.node_id not in current['members']]
        survivors = [by_id[identity] for identity in current['members'] if identity != unfit[0] and identity in by_id]
        if len(survivors) != 2:
            raise ValueError('fresh_survivor_profiles_required')
        chosen = choose_replacement(survivors, options, cluster)
        if chosen is None:
            raise ValueError('no_assessed_replacement')
        members = sorted([profile.node_id for profile in survivors]+[chosen.node_id])
        documents = [state['candidates'][identity]['record']['body']['license'] for identity in members]
        body = {'domain':'sfera-mesh-placement-v2','network':directory.network,'cluster':cluster,'epoch':current['epoch']+1,'previous':confirmed['record_hash'],'members':members,'licenses_hash':sha256(canonical(documents)).hexdigest()}
        manifest=state.get('manifests',{}).get(cluster)
        if manifest is not None:
            body.update(domain='sfera-mesh-placement-v3',manifest_hash=manifest['digest'],readiness_hash='0'*64)
        return json.loads(canonical({'body':body,'licenses':documents}))


class PlacementSigner:
    def __init__(self, key, directory):
        self.key, self.directory = key, directory

    def initial_consent(self,payload):
        from .initial_controller import initial_proposals
        if not isinstance(payload,dict) or set(payload)!={'count','pool_hash','proposal'}:
            raise ValueError('invalid_initial_consent_request')
        with self.directory.lock:
            plan,proposals=initial_proposals(self.directory,payload['count'])
            if payload['pool_hash']!=plan['pool_hash'] or not any(canonical(proposal)==canonical(payload['proposal']) for proposal in proposals):
                raise ValueError('initial_plan_changed')
            proposal=payload['proposal']
            issuers={identity:bytes.fromhex(public) for identity,public in self.directory.license_issuers.items()}
            consent=consent_licensed_placement(proposal['body'],proposal['licenses'],self.key,issuers)
            return {'body_hash':sha256(canonical(proposal['body'])).hexdigest(),'consent':consent}

    def manifest_consent(self,payload,store,sender):
        from .manifests import validate_manifest_body
        from .write_capacity import check_write_capacity
        if not isinstance(payload,dict) or set(payload)!={'body'} or not isinstance(payload['body'],dict) or not digest64(payload['body'].get('cluster')):
            raise ValueError('invalid_manifest_consent_request')
        body=payload['body']
        with self.directory.lock:
            self.directory.anchor()
            head=self.directory.placement(body['cluster'])
            placement={'record':head['record'],'digest':head['record_hash']}
            validate_manifest_body(body,self.directory.network,placement)
            if body['domain']!='sfera-mesh-manifest-v2': raise ValueError('sized_manifest_required')
            members=head['record']['body']['members']
            if sender not in members or node_id(self.key.public_key().public_bytes_raw()) not in members:
                raise ValueError('manifest_current_holder_required')
            check_write_capacity(self.directory.current['state'], body['cluster'], dict(zip(body['digests'], body['sizes'])))
            old=self.directory.current['state'].get('manifests',{}).get(body['cluster'])
            if old:
                prior=old['record']['body']
                if body['version']!=prior['version']+1 or body['previous']!=old['digest'] or not set(prior['digests']).issubset(body['digests']):
                    raise ValueError('manifest_proposal_changed')
                if 'sizes' in prior:
                    sizes=dict(zip(body['digests'],body['sizes']))
                    if any(sizes[digest]!=size for digest,size in zip(prior['digests'],prior['sizes'])):
                        raise ValueError('manifest_committed_size_changed')
            elif body['version']!=1: raise ValueError('manifest_proposal_changed')
            for digest,size in zip(body['digests'],body['sizes']):
                result=store.execute('get',{'digest':digest})
                data=bytes.fromhex(result['ciphertext']) if 'ciphertext' in result else None
                if data is None or len(data)!=size or sha256(data).hexdigest()!=digest:
                    raise ValueError('manifest_local_copy_mismatch')
            consent={'public_key':self.key.public_key().public_bytes_raw().hex(),'signature':self.key.sign(canonical(body)).hex()}
            return {'body_hash':sha256(canonical(body)).hexdigest(),'consent':consent}

    def consent(self, payload):
        if not isinstance(payload, dict) or set(payload) not in ({'body','licenses'},{'body','licenses','readiness'}):
            raise ValueError('invalid_placement_request')
        body = payload['body']
        if not isinstance(body, dict) or 'cluster' not in body:
            raise ValueError('invalid_placement_request')
        with self.directory.lock:
            expected = replacement_proposal(self.directory, body['cluster'])
            if canonical(expected) != canonical(base_proposal(payload)):
                raise ValueError('placement_not_current_best_assessed_replacement')
            if body['domain']=='sfera-mesh-placement-v3': validate_readiness(payload.get('readiness'),body,now=int(time.time()))
            issuers = {identity:bytes.fromhex(public) for identity,public in self.directory.license_issuers.items()}
            consent = consent_licensed_placement(body, payload['licenses'], self.key, issuers)
            return {'body_hash':sha256(canonical(body)).hexdigest(), 'consent':consent}

    def ready(self,payload,store):
        with self.directory.lock:
            expected=replacement_proposal(self.directory,payload['body']['cluster'])
            if canonical(expected)!=canonical(payload) or payload['body']['domain']!='sfera-mesh-placement-v3': raise ValueError('readiness_proposal_changed')
            current=self.directory.placement(payload['body']['cluster'])['record']['body']['members']
            target=set(payload['body']['members'])-set(current)
            if target!={node_id(self.key.public_key().public_bytes_raw())}: raise ValueError('readiness_wrong_target')
            manifest=self.directory.manifest(payload['body']['cluster'])
            index=manifest['record']['body']
            for position,digest in enumerate(index['digests']):
                result=store.execute('get',{'digest':digest})
                if result.get('digest')!=digest or 'ciphertext' not in result or sha256(bytes.fromhex(result['ciphertext'])).hexdigest()!=digest: raise ValueError('readiness_copy_missing')
                if index['domain']=='sfera-mesh-manifest-v2' and len(bytes.fromhex(result['ciphertext']))!=index['sizes'][position]:
                    raise ValueError('readiness_copy_size_mismatch')
            return readiness_proof(payload['body'],self.key)

    def reserve(self,payload,store,sender):
        """A current holder may reserve indexed ciphertext on the sole target."""
        if not isinstance(payload,dict) or set(payload)!={'proposal','blocks'} or not isinstance(payload['proposal'],dict):
            raise ValueError('invalid_placement_reservation')
        proposal=payload['proposal']
        if not isinstance(proposal.get('body'),dict) or not digest64(proposal['body'].get('cluster')):
            raise ValueError('invalid_placement_reservation')
        with self.directory.lock:
            cluster=proposal['body']['cluster']
            expected=replacement_proposal(self.directory,cluster)
            if canonical(expected)!=canonical(proposal) or proposal['body']['domain']!='sfera-mesh-placement-v3':
                raise ValueError('reservation_proposal_changed')
            current=self.directory.placement(cluster)['record']['body']['members']
            if sender not in current: raise ValueError('reservation_current_holder_required')
            target=set(proposal['body']['members'])-set(current)
            if target!={node_id(self.key.public_key().public_bytes_raw())}: raise ValueError('reservation_wrong_target')
            manifest=self.directory.manifest(cluster)
            blocks=payload['blocks']
            if not isinstance(blocks,dict) or not blocks or not set(blocks).issubset(manifest['record']['body']['digests']):
                raise ValueError('reservation_unindexed_blocks')
            index=manifest['record']['body']
            if index['domain']=='sfera-mesh-manifest-v2':
                sizes=dict(zip(index['digests'],index['sizes']))
                if any(type(size) is not int or size!=sizes[digest] for digest,size in blocks.items()):
                    raise ValueError('reservation_committed_size_mismatch')
            plan=sha256(canonical({'proposal':proposal,'manifest':manifest['digest']})).hexdigest()
            result=store.reserve_blocks(blocks,cluster=cluster,plan=plan)
            return {'body_hash':sha256(canonical(proposal['body'])).hexdigest(),**result}

    def release(self,payload,store,sender):
        """Release only after finality makes the old transition unusable."""
        if not isinstance(payload,dict) or set(payload) not in ({'proposal','digests'},{'proposal','digests','ancestry'}) or not isinstance(payload['proposal'],dict):
            raise ValueError('invalid_placement_release')
        proposal=payload['proposal']; body=proposal.get('body')
        if not isinstance(body,dict) or body.get('domain')!='sfera-mesh-placement-v3' or body.get('network')!=self.directory.network or not digest64(body.get('cluster')) or not digest64(body.get('previous')) or not digest64(body.get('manifest_hash')) or type(body.get('epoch')) is not int or body['epoch']<2 or not isinstance(body.get('members'),list) or len(body['members'])!=3 or any(not digest64(member) for member in body['members']):
            raise ValueError('invalid_placement_release')
        digests=payload['digests']
        if not isinstance(digests,list) or not 1<=len(digests)<=512 or any(not digest64(digest) for digest in digests):
            raise ValueError('invalid_placement_release')
        with self.directory.lock:
            self.directory.anchor()
            current=self.directory.placement(body['cluster'])['record']['body']
            manifest=self.directory.current['state'].get('manifests',{}).get(body['cluster'])
            successor=manifest['record']['body'] if manifest else {}
            superseded=(current['epoch']==body['epoch']-1 and
                        successor.get('epoch')==current['epoch'] and
                        successor.get('placement_hash')==body['previous'] and
                        successor.get('previous')==body['manifest_hash'])
            if 'ancestry' in payload:
                from .manifest_ancestry import verify_ancestor
                verify_ancestor(self.directory.current['state'],self.directory.network,body['cluster'],body['manifest_hash'],payload['ancestry'])
                superseded=(current['epoch']==body['epoch']-1 and
                            successor.get('epoch')==current['epoch'] and
                            successor.get('placement_hash')==body['previous'])
            expired=reservation_license_expired(proposal,self.directory.current['state']['block_time'])
            if current['epoch']<body['epoch'] and not superseded and not expired:
                raise ValueError('release_requires_finalized_transition')
            history=self.directory.current['state'].get('placement_history',{}).get(body['cluster'],[])
            prior=next((head['record']['body'] for head in history if head['digest']==body['previous'] and head['record']['body']['epoch']==body['epoch']-1),None)
            if prior is None or sender not in prior['members']: raise ValueError('release_historical_holder_required')
            if set(body['members'])-set(prior['members'])!={node_id(self.key.public_key().public_bytes_raw())}:
                raise ValueError('release_wrong_target')
            plan=sha256(canonical({'proposal':proposal,'manifest':body['manifest_hash']})).hexdigest()
            store.release_blocks(digests,cluster=body['cluster'],plan=plan)
            return {'body_hash':sha256(canonical(body)).hexdigest(),'released':True}


class ReplacementController:
    def __init__(self, path, directory, address, journal):
        validate_address(address)
        if not isinstance(directory, ConsensusDirectory) or directory.network != journal.verifier.network or not directory.placement_assessors:
            raise ValueError('matching_quorum_directory_required')
        self.directory, self.address, self.journal = directory, address, journal
        self.lock = threading.RLock()
        self.process_lock = RefreshLock(None if str(path)==':memory:' else str(Path(path).resolve())+'.replacement.lock')
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS replacement_pin(singleton INTEGER PRIMARY KEY CHECK(singleton=1), context BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS replacement_jobs(cluster TEXT PRIMARY KEY, record BLOB, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at REAL NOT NULL DEFAULT 0, error TEXT);
        ''')
        context = canonical({'genesis':directory.pin,'node':node_id(journal.key.public_key().public_bytes_raw()),'endpoints':journal.endpoints})
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                old = self.db.execute('SELECT context FROM replacement_pin').fetchone()
                if old and old[0] != context:
                    raise ValueError('replacement_context_changed')
                self.db.execute('INSERT OR IGNORE INTO replacement_pin VALUES(1,?)',(context,))
        except Exception:
            self.db.close()
            raise

    def close(self):
        with self.lock:
            self.db.close()

    def status(self, cluster):
        with self.lock:
            row = self.db.execute('SELECT state,attempts,retry_at,error FROM replacement_jobs WHERE cluster=?',(cluster,)).fetchone()
            return dict(zip(('state','attempts','retry_at','error'),row)) if row else {'state':'idle'}

    def step(self, cluster):
        if not digest64(cluster):
            raise ValueError('invalid_replacement_cluster')
        with self.lock:
            if not self.process_lock.acquire():
                return {'state':'busy'}
            try:
                row = self.db.execute('SELECT record,state,attempts,retry_at FROM replacement_jobs WHERE cluster=?',(cluster,)).fetchone()
                if row and row[3] > time.time():
                    return self.status(cluster)
                self.directory.refresh(self.address)
                confirmed = self.directory.placement(cluster)
                pending = json.loads(row[0]) if row and row[0] else None
                if pending and confirmed['record']['body']['epoch'] >= pending['body']['epoch'] and confirmed['record_hash'] != sha256(canonical(pending)).hexdigest():
                    pending = confirmed['record']
                    with self.db:
                        self.db.execute("UPDATE replacement_jobs SET record=?,state='repairing',retry_at=0 WHERE cluster=?",(canonical(pending),cluster))
                    row = (canonical(pending),'repairing',0,0)
                if pending and confirmed['record_hash'] == sha256(canonical(pending)).hexdigest() and row[1] == 'complete':
                    if not self.journal.transfer_status(self.directory, cluster)['complete']:
                        row = (row[0], 'repairing', row[2], row[3])
                if pending and confirmed['record_hash'] == sha256(canonical(pending)).hexdigest() and row[1] != 'complete':
                    profiles = self.directory.placement_candidates(cluster=cluster)
                    self.journal.apply_confirmed_placement(self.directory, cluster, profiles)
                    self.journal.enqueue_confirmed_manifest(self.directory,cluster)
                    self.journal.run_batch(cluster)
                    incomplete = not self.journal.transfer_status(self.directory, cluster)['complete']
                    with self.db:
                        self.db.execute("UPDATE replacement_jobs SET state=?,attempts=0,retry_at=?,error=NULL WHERE cluster=?",('repairing' if incomplete else 'complete',time.time()+2 if incomplete else 0,cluster))
                    return self.status(cluster)
                try:
                    proposal = replacement_proposal(self.directory, cluster)
                except ValueError as exc:
                    if row and row[1] == 'complete' and str(exc) == 'one_quorum_assessed_unfit_member_required':
                        return self.status(cluster)
                    raise
                preparation = self.journal.prepare_replacement(self.directory,proposal)
                if not preparation['ready']:
                    with self.db:
                        self.db.execute("INSERT OR IGNORE INTO replacement_jobs(cluster,state) VALUES(?,'preparing')",(cluster,))
                        self.db.execute("UPDATE replacement_jobs SET state='preparing',retry_at=?,error=? WHERE cluster=?",(time.time()+1,preparation.get('reason','preparation_in_progress'),cluster))
                    return self.status(cluster)
                reusable=pending is not None and canonical(base_proposal(pending))==canonical(proposal)
                if reusable and proposal['body']['domain']=='sfera-mesh-placement-v3':
                    try: validate_readiness(pending.get('readiness'),pending['body'],now=int(time.time()))
                    except ValueError: reusable=False
                if not reusable:
                    if proposal['body']['domain']=='sfera-mesh-placement-v3':
                        old=set(confirmed['record']['body']['members'])
                        target=next(iter(set(proposal['body']['members'])-old))
                        proof=exchange(self.journal.endpoints[target],self.journal.key,self.journal.verifier,target,'placement-ready',proposal)
                        proposal={**proposal,'body':{**proposal['body'],'readiness_hash':sha256(canonical(proof)).hexdigest()},'readiness':proof}
                        validate_readiness(proof,proposal['body'],now=int(time.time()))
                    consents = []
                    for identity in proposal['body']['members']:
                        if identity not in self.journal.endpoints:
                            raise ValueError('replacement_endpoint_not_pinned')
                        result = exchange(self.journal.endpoints[identity],self.journal.key,self.journal.verifier,identity,'placement-consent',proposal)
                        consents.append(result['consent'])
                    pending = {**proposal,'consents':consents}
                    validate_placement(pending, self.directory.network)
                    # Persist the exact signed transaction before broadcasting.
                    with self.db:
                        self.db.execute("INSERT INTO replacement_jobs(cluster,record,state) VALUES(?,?,'prepared') ON CONFLICT(cluster) DO UPDATE SET record=excluded.record,state='prepared',retry_at=0,error=NULL",(cluster,canonical(pending)))
                result = rpc(self.address,'broadcast_tx_sync',{'tx':base64.b64encode(canonical(pending)).decode()})
                if result.get('code',0):
                    raise ValueError('replacement_transaction_rejected')
                with self.db:
                    self.db.execute("UPDATE replacement_jobs SET state='submitted',retry_at=?,error=NULL WHERE cluster=?",(time.time()+2,cluster))
                return self.status(cluster)
            except (ValueError,OSError,sqlite3.Error) as exc:
                if isinstance(exc,HTTPError):
                    exc.close()
                with self.db:
                    self.db.execute("INSERT OR IGNORE INTO replacement_jobs(cluster,state) VALUES(?,'waiting')",(cluster,))
                    attempts = self.db.execute('SELECT attempts FROM replacement_jobs WHERE cluster=?',(cluster,)).fetchone()[0]+1
                    # Store a bounded category, never signed payloads or keys.
                    error = str(exc) if isinstance(exc,ValueError) and len(str(exc))<=96 else 'replacement_unavailable'
                    self.db.execute("UPDATE replacement_jobs SET state='waiting',attempts=?,retry_at=?,error=? WHERE cluster=?",(attempts,time.time()+min(60,2**min(attempts,6)),error,cluster))
                return self.status(cluster)
            finally:
                self.process_lock.release()
