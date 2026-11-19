"""Isolated loopback HTTP replication lab. Not a public production endpoint.

Authenticated peers can store/fetch immutable ciphertext. No signing authority,
licence inheritance, account login or consensus acknowledgement is exposed.
"""
import json
from pathlib import Path
import sqlite3
import threading
import time
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from .identity import MAX_BYTES, envelope, node_id
from .storage import canonical


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_http_state = threading.local()


def _http_opener():
    # No cookies/auth state or persistent connections: only reuse stateless
    # handler setup. In particular, avoid reloading Windows trust stores for
    # every loopback HTTP block. Each worker thread owns its handler instances.
    if getattr(_http_state, 'factory', None) is not build_opener:
        _http_state.opener = build_opener(ProxyHandler({}), NoRedirect())
        _http_state.factory = build_opener
    return _http_state.opener


class BlobStore:
    def __init__(self, path, *, max_bytes=None, disk_budget=None):
        self.path=None if str(path)==':memory:' else Path(path).resolve()
        self.disk_budget=disk_budget
        if max_bytes is not None and (type(max_bytes) is not int or not 1 <= max_bytes <= 2**63-1):
            raise ValueError('invalid_blob_byte_limit')
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS blobs (digest TEXT PRIMARY KEY, data BLOB NOT NULL)")
        self.lock = threading.RLock()
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                self.db.execute('CREATE TABLE IF NOT EXISTS blob_limits(singleton INTEGER PRIMARY KEY CHECK(singleton=1),max_bytes INTEGER)')
                old = self.db.execute('SELECT max_bytes FROM blob_limits').fetchone()
                if old is not None and max_bytes is not None and old[0] != max_bytes:
                    raise ValueError('blob_byte_limit_changed')
                if old is None:
                    used = self.db.execute('SELECT COALESCE(SUM(LENGTH(data)),0) FROM blobs').fetchone()[0]
                    if max_bytes is not None and used > max_bytes:
                        raise ValueError('existing_blobs_exceed_byte_limit')
                    self.db.execute('INSERT INTO blob_limits VALUES(1,?)',(max_bytes,))
                self.db.execute('CREATE TABLE IF NOT EXISTS blob_usage(singleton INTEGER PRIMARY KEY CHECK(singleton=1),used_bytes INTEGER NOT NULL CHECK(used_bytes>=0))')
                if self.db.execute('SELECT 1 FROM blob_usage').fetchone() is None:
                    self.db.execute('INSERT INTO blob_usage SELECT 1,COALESCE(SUM(LENGTH(data)),0) FROM blobs')
                # REPLACE may suppress DELETE triggers on other connections.
                # Keep prior sizes independently so INSERT can account a delta.
                if self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='blob_sizes'").fetchone() is None:
                    self.db.execute('CREATE TABLE blob_sizes(digest TEXT PRIMARY KEY,size INTEGER NOT NULL CHECK(size>=0))')
                    self.db.execute('INSERT INTO blob_sizes SELECT digest,LENGTH(data) FROM blobs')
                    self.db.execute('UPDATE blob_usage SET used_bytes=(SELECT COALESCE(SUM(size),0) FROM blob_sizes)')
                    for name in ('blob_usage_insert','blob_usage_update','blob_usage_delete'):
                        self.db.execute('DROP TRIGGER IF EXISTS '+name)
                self.db.execute('CREATE TRIGGER IF NOT EXISTS blob_usage_insert AFTER INSERT ON blobs BEGIN UPDATE blob_usage SET used_bytes=used_bytes-COALESCE((SELECT size FROM blob_sizes WHERE digest=NEW.digest),0)+LENGTH(NEW.data) WHERE singleton=1; INSERT INTO blob_sizes VALUES(NEW.digest,LENGTH(NEW.data)) ON CONFLICT(digest) DO UPDATE SET size=excluded.size; END')
                self.db.execute('CREATE TRIGGER IF NOT EXISTS blob_usage_update AFTER UPDATE ON blobs BEGIN UPDATE blob_usage SET used_bytes=used_bytes-COALESCE((SELECT size FROM blob_sizes WHERE digest=OLD.digest),0)+LENGTH(NEW.data) WHERE singleton=1; DELETE FROM blob_sizes WHERE digest=OLD.digest; INSERT INTO blob_sizes VALUES(NEW.digest,LENGTH(NEW.data)) ON CONFLICT(digest) DO UPDATE SET size=excluded.size; END')
                self.db.execute('CREATE TRIGGER IF NOT EXISTS blob_usage_delete AFTER DELETE ON blobs BEGIN UPDATE blob_usage SET used_bytes=used_bytes-COALESCE((SELECT size FROM blob_sizes WHERE digest=OLD.digest),0) WHERE singleton=1; DELETE FROM blob_sizes WHERE digest=OLD.digest; END')
                # Enforce the same limit for older writers sharing this DB.
                if self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='blob_growth'").fetchone() is None:
                    self.db.execute('CREATE TABLE blob_growth(owner TEXT PRIMARY KEY,placement TEXT NOT NULL,initial_bytes INTEGER NOT NULL CHECK(initial_bytes>0),remaining_bytes INTEGER NOT NULL CHECK(remaining_bytes>=0 AND remaining_bytes<=initial_bytes),closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN(0,1)))')
                    self.db.execute('CREATE TABLE blob_growth_spends(owner TEXT NOT NULL,digest TEXT NOT NULL,size INTEGER NOT NULL,PRIMARY KEY(owner,digest))')
                    self.db.execute('DROP TRIGGER IF EXISTS blob_quota_insert')
                    self.db.execute('DROP TRIGGER IF EXISTS blob_quota_update')
                self.db.execute('CREATE TABLE IF NOT EXISTS blob_growth_proposals(owner TEXT PRIMARY KEY,body BLOB NOT NULL)')
                # Subtraction first avoids overflow near SQLite's integer bound.
                if self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='blob_reservations'").fetchone() is None:
                    self.db.execute('CREATE TABLE blob_reservations(digest TEXT PRIMARY KEY,size INTEGER NOT NULL CHECK(size>0))')
                    self.db.execute('DROP TRIGGER IF EXISTS blob_quota_insert')
                    self.db.execute('DROP TRIGGER IF EXISTS blob_quota_update')
                self.db.execute("CREATE TRIGGER IF NOT EXISTS blob_quota_insert BEFORE INSERT ON blobs WHEN (SELECT max_bytes FROM blob_limits WHERE singleton=1) IS NOT NULL BEGIN SELECT CASE WHEN LENGTH(NEW.data) > (SELECT max_bytes-used_bytes FROM blob_limits JOIN blob_usage USING(singleton))-(SELECT COALESCE(SUM(remaining_bytes),0) FROM blob_growth)-(SELECT COALESCE(SUM(size),0) FROM blob_reservations WHERE digest!=NEW.digest)+COALESCE((SELECT LENGTH(data) FROM blobs WHERE digest=NEW.digest),0) THEN RAISE(ABORT,'blob_byte_limit_exceeded') END; END")
                self.db.execute("CREATE TRIGGER IF NOT EXISTS blob_quota_update BEFORE UPDATE OF data ON blobs WHEN (SELECT max_bytes FROM blob_limits WHERE singleton=1) IS NOT NULL BEGIN SELECT CASE WHEN LENGTH(NEW.data) > (SELECT max_bytes-used_bytes FROM blob_limits JOIN blob_usage USING(singleton))-(SELECT COALESCE(SUM(remaining_bytes),0) FROM blob_growth)-(SELECT COALESCE(SUM(size),0) FROM blob_reservations WHERE digest!=NEW.digest)+LENGTH(OLD.data) THEN RAISE(ABORT,'blob_byte_limit_exceeded') END; END")
                self.db.execute('CREATE TRIGGER IF NOT EXISTS blob_reservation_insert AFTER INSERT ON blobs BEGIN DELETE FROM blob_reservations WHERE digest=NEW.digest; END')
                self.db.execute('CREATE TRIGGER IF NOT EXISTS blob_reservation_update AFTER UPDATE OF data ON blobs BEGIN DELETE FROM blob_reservations WHERE digest=NEW.digest; END')
                if self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='blob_reservation_owners'").fetchone() is None:
                    self.db.execute('CREATE TABLE blob_reservation_owners(owner TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(owner,digest))')
                    self.db.execute("INSERT INTO blob_reservation_owners SELECT 'local',digest FROM blob_reservations")
                self.db.execute('CREATE TRIGGER IF NOT EXISTS blob_reservation_cleanup AFTER DELETE ON blob_reservations BEGIN DELETE FROM blob_reservation_owners WHERE digest=OLD.digest; END')
                from .disk_budget import DiskBudget
                if disk_budget is not None and (not isinstance(disk_budget,DiskBudget) or self.path not in disk_budget.paths):
                    raise ValueError('disk_budget_must_include_blob_database')
                self.db.execute('CREATE TABLE IF NOT EXISTS blob_disk_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1),config BLOB NOT NULL)')
                policy=self.db.execute('SELECT config FROM blob_disk_policy').fetchone()
                if policy:
                    if disk_budget is not None and canonical(disk_budget.config())!=policy[0]:raise ValueError('disk_budget_policy_changed')
                    self.disk_budget=DiskBudget(**json.loads(policy[0]))
                    if self.path not in self.disk_budget.paths:raise ValueError('disk_budget_database_path_changed')
                elif disk_budget is not None:
                    self.db.execute('INSERT INTO blob_disk_policy VALUES(1,?)',(canonical(disk_budget.config()),))
        except Exception:
            self.db.close()
            raise

    def close(self):
        self.db.close()

    def usage(self):
        with self.lock:
            limit,used,reserved = self.db.execute('SELECT max_bytes,used_bytes,(SELECT COALESCE(SUM(size),0) FROM blob_reservations)+(SELECT COALESCE(SUM(remaining_bytes),0) FROM blob_growth) FROM blob_limits JOIN blob_usage USING(singleton)').fetchone()
            available=None if limit is None else max(0,limit-used-reserved)
            if self.disk_budget is not None:
                physical=self.disk_budget.sample(reserved)['available_bytes']
                available=physical if available is None else min(available,physical)
            return {'used_bytes':used,'max_bytes':limit,'available_bytes':available}

    @staticmethod
    def _reservation_owner(cluster,plan):
        if cluster is None and plan is None: return 'local'
        if any(not isinstance(value,str) or len(value)!=64 or any(c not in '0123456789abcdef' for c in value) for value in (cluster,plan)):
            raise ValueError('invalid_blob_reservation_owner')
        return cluster+':'+plan

    def reserve_growth(self,cluster,budget,placement,amount,*,proposal=None):
        """Reserve bytes before ciphertext/digests exist. Exact retry never refills."""
        owner=self._reservation_owner(cluster,budget)
        self._reservation_owner(cluster,placement)
        if type(amount) is not int or not 1<=amount<=2**63-1:raise ValueError('invalid_growth_amount')
        with self.lock,self.db:
            self.db.execute('BEGIN IMMEDIATE')
            old=self.db.execute('SELECT placement,initial_bytes,remaining_bytes,closed FROM blob_growth WHERE owner=?',(owner,)).fetchone()
            if proposal is not None:
                encoded=canonical(proposal)
                if len(encoded)>4096:raise ValueError('invalid_growth_proposal')
                saved=self.db.execute('SELECT body FROM blob_growth_proposals WHERE owner=?',(owner,)).fetchone()
                if saved and saved[0]!=encoded:raise ValueError('growth_proposal_conflict')
                self.db.execute('INSERT OR IGNORE INTO blob_growth_proposals VALUES(?,?)',(owner,encoded))
            if old:
                if old[:2]!=(placement,amount):raise ValueError('growth_budget_conflict')
                return {'initial_bytes':amount,'remaining_bytes':old[2],'closed':bool(old[3])}
            if self.db.execute('SELECT COUNT(*) FROM blob_growth').fetchone()[0]>=128:raise ValueError('growth_budget_limit')
            usage=self.usage()
            if usage['max_bytes'] is None:raise ValueError('bounded_blob_store_required')
            if amount>usage['available_bytes']:raise ValueError('blob_byte_limit_exceeded')
            self.db.execute('INSERT INTO blob_growth VALUES(?,?,?,?,0)',(owner,placement,amount,amount))
            return {'initial_bytes':amount,'remaining_bytes':amount,'closed':False}

    def growth_budget(self,cluster,budget):
        owner=self._reservation_owner(cluster,budget)
        with self.lock:
            row=self.db.execute('SELECT placement,initial_bytes,remaining_bytes,closed FROM blob_growth WHERE owner=?',(owner,)).fetchone()
            if row is None:raise ValueError('growth_budget_required')
            return {'placement_hash':row[0],'initial_bytes':row[1],'remaining_bytes':row[2],'closed':bool(row[3])}

    def growth_proposal(self,cluster,budget):
        owner=self._reservation_owner(cluster,budget)
        with self.lock:
            row=self.db.execute('SELECT body FROM blob_growth_proposals WHERE owner=?',(owner,)).fetchone()
            if row is None:raise ValueError('growth_proposal_required')
            return json.loads(row[0])

    def release_growth(self,cluster,budget):
        owner=self._reservation_owner(cluster,budget)
        with self.lock,self.db:
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('UPDATE blob_growth SET remaining_bytes=0,closed=1 WHERE owner=?',(owner,))

    def reserve_blocks(self, blocks, *, cluster=None, plan=None):
        """Local bounded reservation of exact ciphertext digests; not a lease.

        No automatic expiry or remote admission. A valid put consumes its
        reservation atomically; an operator can explicitly release unused ones.
        """
        owner=self._reservation_owner(cluster,plan)
        if not isinstance(blocks,dict) or not 1<=len(blocks)<=512 or any(
                not isinstance(digest,str) or len(digest)!=64 or any(c not in '0123456789abcdef' for c in digest)
                or type(size) is not int or not 1<=size<=262144 for digest,size in blocks.items()):
            raise ValueError('invalid_blob_reservations')
        with self.lock,self.db:
            self.db.execute('BEGIN IMMEDIATE')
            limit,used=self.db.execute('SELECT max_bytes,used_bytes FROM blob_limits JOIN blob_usage USING(singleton)').fetchone()
            if limit is None: raise ValueError('bounded_blob_store_required')
            pending=dict(self.db.execute('SELECT digest,size FROM blob_reservations'))
            for digest,size in blocks.items():
                old=self.db.execute('SELECT LENGTH(data) FROM blobs WHERE digest=?',(digest,)).fetchone()
                if old:
                    if old[0]!=size: raise ValueError('blob_reservation_size_conflict')
                    continue
                if digest in pending and pending[digest]!=size: raise ValueError('blob_reservation_size_conflict')
                pending[digest]=size
            if len(pending)>512: raise ValueError('blob_reservation_limit')
            growth=self.db.execute('SELECT COALESCE(SUM(remaining_bytes),0) FROM blob_growth').fetchone()[0]
            if sum(pending.values())>limit-used-growth: raise ValueError('blob_byte_limit_exceeded')
            if self.disk_budget is not None:self.disk_budget.require(sum(pending.values())+growth)
            self.db.executemany('INSERT OR IGNORE INTO blob_reservations VALUES(?,?)',pending.items())
            self.db.executemany('INSERT OR IGNORE INTO blob_reservation_owners VALUES(?,?)',[(owner,digest) for digest in blocks if digest in pending])
            if self.db.execute('SELECT COUNT(*) FROM blob_reservation_owners').fetchone()[0]>512:
                raise ValueError('blob_reservation_owner_limit')
            return {'reserved_bytes':sum(pending.values()),'blocks':len(pending)}

    def release_blocks(self, digests, *, cluster=None, plan=None):
        """Explicit local cancellation; never deletes ciphertext."""
        owner=self._reservation_owner(cluster,plan)
        if not isinstance(digests,list) or not 1<=len(digests)<=512 or any(not isinstance(d,str) for d in digests):
            raise ValueError('invalid_blob_reservation_release')
        with self.lock,self.db:
            self.db.execute('BEGIN IMMEDIATE')
            self.db.executemany('DELETE FROM blob_reservation_owners WHERE owner=? AND digest=?',[(owner,d) for d in digests])
            self.db.executemany('DELETE FROM blob_reservations WHERE digest=? AND NOT EXISTS(SELECT 1 FROM blob_reservation_owners WHERE digest=?)',[(d,d) for d in digests])

    def audit_usage(self):
        """Explicit full local audit; a single snapshot, no repair or deletion.

        Unlike usage(), this scans stored blocks and is intended for operator
        diagnostics before trusting migrated/restored accounting.
        """
        with self.lock:
            row=self.db.execute('''SELECT
                (SELECT used_bytes FROM blob_usage WHERE singleton=1),
                (SELECT COALESCE(SUM(LENGTH(data)),0) FROM blobs),
                (SELECT COALESCE(SUM(size),0) FROM blob_sizes),
                (SELECT COUNT(*) FROM blobs b LEFT JOIN blob_sizes s ON s.digest=b.digest
                    WHERE s.digest IS NULL OR s.size!=LENGTH(b.data))+
                (SELECT COUNT(*) FROM blob_sizes s LEFT JOIN blobs b ON b.digest=s.digest
                    WHERE b.digest IS NULL),
                (SELECT max_bytes FROM blob_limits WHERE singleton=1),
                (SELECT COALESCE(SUM(size),0) FROM blob_reservations)+(SELECT COALESCE(SUM(remaining_bytes),0) FROM blob_growth)
            ''').fetchone()
            accounted,actual,indexed,mismatches,limit,reserved=row
            within=limit is None or actual+reserved<=limit
            result={'consistent':accounted==actual==indexed and mismatches==0,
                    'accounted_bytes':accounted,'actual_bytes':actual,
                    'indexed_bytes':indexed,'mismatched_rows':mismatches,
                    'max_bytes':limit,'reserved_bytes':reserved,'within_limit':within}
            if self.disk_budget is not None:
                result['disk']=self.disk_budget.sample(reserved)
                result['within_limit']=within and result['disk']['within_limit']
            return result

    def execute(self, operation, payload):
        if not isinstance(payload, dict):
            raise ValueError("invalid_payload")
        if operation == "put" and set(payload) in ({"digest", "ciphertext"},{"digest", "ciphertext","growth"}):
            if not isinstance(payload["ciphertext"], str) or len(payload["ciphertext"]) > 524288:
                raise ValueError("invalid_ciphertext")
            data = bytes.fromhex(payload["ciphertext"])
            digest = sha256(data).hexdigest()
            if not data or digest != payload["digest"]:
                raise ValueError("digest_mismatch")
            with self.lock, self.db:
                # Serialize the check and write across independent processes,
                # not merely across threads using this BlobStore instance.
                self.db.execute('BEGIN IMMEDIATE')
                if 'growth' in payload:
                    growth=payload['growth']
                    if not isinstance(growth,dict) or set(growth)!={'cluster','budget'}:raise ValueError('invalid_growth_owner')
                    owner=self._reservation_owner(growth['cluster'],growth['budget'])
                    budget=self.growth_budget(growth['cluster'],growth['budget'])
                    if budget['closed']:raise ValueError('growth_budget_closed')
                    spent=self.db.execute('SELECT size FROM blob_growth_spends WHERE owner=? AND digest=?',(owner,digest)).fetchone()
                    if spent and spent[0]!=len(data):raise ValueError('growth_spend_size_conflict')
                    existing=self.db.execute('SELECT LENGTH(data) FROM blobs WHERE digest=?',(digest,)).fetchone()
                    cost=0 if spent or existing and existing[0]==len(data) else len(data)
                    if cost>budget['remaining_bytes']:raise ValueError('growth_budget_exhausted')
                    if not spent:
                        if self.db.execute('SELECT COUNT(*) FROM blob_growth_spends').fetchone()[0]>=4096:raise ValueError('growth_spend_limit')
                        self.db.execute('UPDATE blob_growth SET remaining_bytes=remaining_bytes-? WHERE owner=?',(cost,owner))
                        self.db.execute('INSERT INTO blob_growth_spends VALUES(?,?,?)',(owner,digest,len(data)))
                limit = self.db.execute('SELECT max_bytes FROM blob_limits').fetchone()[0]
                if limit is not None:
                    used = self.db.execute('SELECT used_bytes FROM blob_usage WHERE singleton=1').fetchone()[0]
                    old = self.db.execute('SELECT LENGTH(data) FROM blobs WHERE digest=?',(digest,)).fetchone()
                    reserved=self.db.execute('SELECT (SELECT COALESCE(SUM(size),0) FROM blob_reservations WHERE digest!=?)+(SELECT COALESCE(SUM(remaining_bytes),0) FROM blob_growth)',(digest,)).fetchone()[0]
                    if len(data) > limit - used - reserved + (old[0] if old else 0):
                        raise ValueError('blob_byte_limit_exceeded')
                # A valid content-addressed put can safely heal corrupt bytes:
                # its hash was verified above, so the immutable content is unchanged.
                if self.disk_budget is not None:
                    pending=self.db.execute('SELECT (SELECT COALESCE(SUM(size),0) FROM blob_reservations WHERE digest!=?)+(SELECT COALESCE(SUM(remaining_bytes),0) FROM blob_growth)',(digest,)).fetchone()[0]
                    page_size=self.db.execute('PRAGMA page_size').fetchone()[0]
                    self.disk_budget.require(3*len(data)+16*page_size,pending)
                self.db.execute("INSERT INTO blobs VALUES (?, ?) ON CONFLICT(digest) DO UPDATE SET data=excluded.data", (digest, data))
            return {"digest": digest, "stored": True}
        if operation == "get" and set(payload) == {"digest"} and isinstance(payload["digest"], str):
            with self.lock:
                row = self.db.execute("SELECT data FROM blobs WHERE digest=?", (payload["digest"],)).fetchone()
            if row is None:
                return {"error": "not_found"}
            if sha256(row[0]).hexdigest() != payload["digest"]:
                raise ValueError("corrupt_storage")
            return {"digest": payload["digest"], "ciphertext": row[0].hex()}
        raise ValueError("unsupported_operation")


class LabServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, key, verifier, store, directory=None, auth=None, *, capacity_sampler=None, placement_signer=None, failure_observer=None, capacity_assessor=None):
        self.key, self.verifier, self.store = key, verifier, store
        self.directory, self.auth = directory, auth
        self.capacity_sampler, self.placement_signer = capacity_sampler, placement_signer
        self.failure_observer = failure_observer
        self.capacity_assessor = capacity_assessor
        if auth is not None and (auth.entry_node != node_id(key.public_key().public_bytes_raw()) or auth.network != verifier.network or auth.directory is not directory):
            raise ValueError('auth_server_identity_mismatch')
        super().__init__(("127.0.0.1", 0), Handler)

    @property
    def endpoint(self):
        return f"http://127.0.0.1:{self.server_address[1]}"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Never log signed payloads or ciphertext.

    def do_POST(self):
        if self.path.startswith('/mesh-lab/auth/'):
            return self.do_auth()
        operation = self.path.removeprefix("/mesh-lab/v1/")
        if self.path not in tuple("/mesh-lab/v1/" + name for name in ("put", "get", "growth-reserve", "growth-release", "probe", "capacity-probe", "capacity-consent", "initial-consent", "manifest-consent", "manifest-submit", "manifest-status", "write-consent", "transfer-consent", "placement-reserve", "placement-release", "placement-consent", "placement-ready", "failure-observation", "failure-consent", "account-put", "account-get", "account-confirm")):
            self.send_error(404)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0 or size > MAX_BYTES:
                raise ValueError("invalid_size")
            self.connection.settimeout(3)
            data = self.rfile.read(size)
            if len(data) != size:
                raise ValueError("incomplete_body")
            request = json.loads(data)
            sender, payload = self.server.verifier.verify(request, operation)
            if operation in ('manifest-submit','manifest-status'):
                queue=getattr(self.server,'manifest_queue',None)
                if queue is None:raise ValueError('manifest_queue_unavailable')
                result=queue.submit(sender,payload) if operation=='manifest-submit' else queue.receipt(sender,payload)
            elif operation in ('growth-reserve','growth-release'):
                if self.server.placement_signer is None:raise ValueError('placement_signer_unavailable')
                from .growth import GrowthParticipant
                participant=GrowthParticipant(self.server.key,self.server.placement_signer.directory,self.server.store)
                result=participant.reserve(payload,sender) if operation=='growth-reserve' else participant.release(payload,sender)
            elif operation in ('failure-observation','failure-consent'):
                if self.server.failure_observer is None:
                    raise ValueError('failure_observer_unavailable')
                result = self.server.failure_observer.observe(payload) if operation=='failure-observation' else self.server.failure_observer.consent(payload)
            elif operation == 'capacity-consent':
                if self.server.capacity_assessor is None: raise ValueError('capacity_assessor_unavailable')
                result = self.server.capacity_assessor.consent(payload)
            elif operation == 'capacity-probe':
                from .directory import digest64
                if self.server.capacity_sampler is None or not isinstance(payload, dict) or set(payload) != {'challenge','data'} or not digest64(payload['challenge']) or not isinstance(payload['data'], str) or len(payload['data']) != 65536 or bytes.fromhex(payload['data']).hex() != payload['data']:
                    raise ValueError('invalid_capacity_probe')
                sample = self.server.capacity_sampler.sample()
                available = self.server.store.usage()['available_bytes']
                if available is not None:
                    sample['free_bytes'] = min(sample['free_bytes'], available)
                result = {**payload, 'sample': sample}
            elif operation == 'initial-consent':
                if self.server.placement_signer is None: raise ValueError('placement_signer_unavailable')
                result=self.server.placement_signer.initial_consent(payload)
            elif operation == 'transfer-consent':
                if self.server.placement_signer is None: raise ValueError('placement_signer_unavailable')
                from .transfer_consensus import transfer_consent
                result=transfer_consent(self.server.placement_signer,payload,self.server.store,sender)
            elif operation == 'write-consent':
                if self.server.placement_signer is None: raise ValueError('placement_signer_unavailable')
                from .write_queue import write_consent
                result=write_consent(self.server.placement_signer,payload,self.server.store,sender)
            elif operation == 'manifest-consent':
                if self.server.placement_signer is None: raise ValueError('placement_signer_unavailable')
                result=self.server.placement_signer.manifest_consent(payload,self.server.store,sender)
            elif operation == 'placement-release':
                if self.server.placement_signer is None: raise ValueError('placement_signer_unavailable')
                result=self.server.placement_signer.release(payload,self.server.store,sender)
            elif operation == 'placement-reserve':
                if self.server.placement_signer is None: raise ValueError('placement_signer_unavailable')
                result=self.server.placement_signer.reserve(payload,self.server.store,sender)
            elif operation in ('placement-consent','placement-ready'):
                if self.server.placement_signer is None:
                    raise ValueError('placement_signer_unavailable')
                result = self.server.placement_signer.consent(payload) if operation=='placement-consent' else self.server.placement_signer.ready(payload,self.server.store)
            elif operation == 'probe':
                from .directory import digest64
                if not isinstance(payload, dict) or set(payload) != {'challenge'} or not digest64(payload['challenge']):
                    raise ValueError('invalid_probe')
                result = {'challenge': payload['challenge'], 'alive': True}
            elif operation.startswith('account-'):
                if self.server.directory is None:
                    raise ValueError('directory_unavailable')
                result = self.server.directory.execute(operation, payload)
            else:
                if operation=='put' and isinstance(payload,dict) and 'growth' in payload:
                    if self.server.placement_signer is None:raise ValueError('placement_signer_unavailable')
                    from .growth import GrowthParticipant
                    result=GrowthParticipant(self.server.key,self.server.placement_signer.directory,self.server.store).put(payload,sender)
                else:result = self.server.store.execute(operation, payload)
            response = envelope(self.server.key, self.server.verifier.network, sender, operation + "-response", {"request_nonce": request["record"]["nonce"], "result": result})
            body = canonical(response)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (ValueError, TypeError, KeyError, UnicodeError, OSError):
            self.send_error(400, "invalid_mesh_request")

    def do_auth(self):
        from .auth import DirectoryNotReady, ChallengeLimit, LoginRequestChanged
        operation = self.path.removeprefix('/mesh-lab/auth/')
        if self.server.auth is None or operation not in ('challenge', 'complete', 'session', 'logout'):
            self.send_error(404)
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 32768 or self.headers.get_content_type() != 'application/json':
                raise ValueError('invalid_auth_request')
            self.connection.settimeout(3)
            data = self.rfile.read(size)
            if len(data) != size:
                raise ValueError('invalid_auth_request')
            payload = json.loads(data)
            bearer = self.headers.get('Authorization', '')
            token = bearer[7:] if bearer.startswith('Bearer ') else None
            response = self.server.auth.execute(operation, payload, token)
            status = 200
        except DirectoryNotReady:
            response, status = {'error': 'mesh_directory_unavailable'}, 503
        except ChallengeLimit:
            response, status = {'error': 'mesh_login_rate_limited'}, 429
        except LoginRequestChanged:
            response, status = {'error': 'mesh_login_retry_required'}, 409
        except (ValueError, TypeError, KeyError, UnicodeError):
            response, status = {'error': 'mesh_auth_failed'}, 401
        body = canonical(response)
        self.send_response(status)
        if status == 429:
            self.send_header('Retry-After', '60')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)


def validate_peer_endpoint(verifier, recipient, endpoint):
    """Validate an operator-pinned peer route without weakening local RPC policy."""
    secure=getattr(verifier,'secure_transport',None)
    if secure is not None:
        from .public_transport import ConfiguredHttpsTransport
        if not isinstance(secure,ConfiguredHttpsTransport):raise ValueError('configured_https_transport_required')
        if recipient not in verifier.roster:raise ValueError('peer_outside_pinned_roster')
        secure.validate(endpoint,recipient)
    else:
        from .consensus_directory import validate_address
        validate_address(endpoint)


def exchange(endpoint, key, verifier, recipient, operation, payload, *, committee=None, _secure_transport=None):
    # Laboratory only: no remote URL supplied by a peer is ever followed.
    from urllib.parse import urlsplit
    url = urlsplit(endpoint)
    _secure_transport=_secure_transport or getattr(verifier,'secure_transport',None)
    if _secure_transport is not None:
        request_url, opener = _secure_transport.route(endpoint,recipient,operation)
    elif url.scheme != "http" or url.hostname != "127.0.0.1" or url.username or url.password or url.path or url.query or url.fragment:
        raise ValueError("loopback_lab_only")
    else:
        request_url,opener=endpoint+"/mesh-lab/v1/"+operation,_http_opener()
    if operation not in ("get", "put", "growth-reserve", "growth-release", "probe", "capacity-probe", "capacity-consent", "initial-consent", "manifest-consent", "manifest-submit", "manifest-status", "write-consent", "transfer-consent", "placement-reserve", "placement-release", "placement-consent", "placement-ready", "failure-observation", "failure-consent", "account-put", "account-get", "account-confirm"):
        raise ValueError("unsupported_operation")
    if operation == 'account-confirm':
        from .directory import validate_directory_certificate
        if committee is None or committee.network != verifier.network:
            raise ValueError('no_trusted_committee')
        validate_directory_certificate(committee, payload['certificate'])
    signed = envelope(key, verifier.network, recipient, operation, payload)
    request = Request(request_url, data=canonical(signed), headers={"Content-Type": "application/json"}, method="POST")
    timeout_seconds=getattr(_secure_transport,'timeout_seconds',3)
    if type(timeout_seconds) is not int or not 1<=timeout_seconds<=10:raise ValueError('bounded_mesh_timeout_required')
    deadline = time.monotonic() + timeout_seconds
    chunks, size = [], 0
    with opener.open(request, timeout=timeout_seconds) as response:
        while size <= MAX_BYTES:
            if time.monotonic() >= deadline:
                raise TimeoutError('mesh_response_deadline')
            chunk = response.read1(min(65536, MAX_BYTES + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
    data = b''.join(chunks)
    if len(data) > MAX_BYTES:
        raise ValueError("response_too_large")
    sender, response = verifier.verify(json.loads(data), operation + "-response")
    if sender != recipient or not isinstance(response, dict) or response.get("request_nonce") != signed["record"]["nonce"]:
        raise ValueError("unexpected_responder_or_request")
    result = response.get("result")
    if not isinstance(result, dict):
        raise ValueError("invalid_result")
    if operation=='growth-reserve':
        if set(result)!={'body_hash','consent'} or result['body_hash']!=sha256(canonical(payload['body'])).hexdigest():raise ValueError('growth_response_mismatch')
        return result
    if operation=='growth-release':
        if result!={'budget_id':payload['budget'],'released':True}:raise ValueError('growth_release_response_mismatch')
        return result
    if operation == 'failure-observation':
        if set(result)!={'body','public_key','signature'} or not isinstance(result['body'],dict) or result['body'].get('cluster')!=payload['cluster']:
            raise ValueError('failure_observation_response_mismatch')
        return result
    if operation=='placement-ready':
        if set(result)!={'body','public_key','signature'}: raise ValueError('invalid_readiness_response')
        return result
    if operation=='placement-release':
        if set(result)!={'body_hash','released'} or result['released'] is not True or result['body_hash']!=sha256(canonical(payload['proposal']['body'])).hexdigest():
            raise ValueError('invalid_placement_release_response')
        return result
    if operation=='placement-reserve':
        if set(result)!={'body_hash','reserved_bytes','blocks'} or result['body_hash']!=sha256(canonical(payload['proposal']['body'])).hexdigest() or type(result['reserved_bytes']) is not int or not 0<=result['reserved_bytes']<=512*262144 or type(result['blocks']) is not int or not 0<=result['blocks']<=512:
            raise ValueError('invalid_placement_reservation_response')
        return result
    if operation == 'capacity-probe':
        if not isinstance(result, dict) or set(result) != {'challenge','data','sample'} or result['challenge'] != payload['challenge'] or result['data'] != payload['data'] or not isinstance(result['sample'], dict) or set(result['sample']) != {'free_bytes','disk_bytes_per_second','sampled_at'}:
            raise ValueError('capacity_response_mismatch')
        return result
    if operation=='initial-consent':
        if set(result)!={'body_hash','consent'} or result['body_hash']!=sha256(canonical(payload['proposal']['body'])).hexdigest():
            raise ValueError('initial_consent_response_mismatch')
        return result
    if operation in ('manifest-submit','manifest-status'):
        from .directory import digest64
        if not isinstance(result,dict) or set(result)!={'request_id','state'} or not digest64(result['request_id']) or result['state'] not in {'queued','prepared','submitted','confirmed','waiting','busy'}:raise ValueError('invalid_manifest_queue_response')
        return result
    if operation in ('placement-consent','failure-consent','capacity-consent','manifest-consent','write-consent','transfer-consent'):
        if not isinstance(result, dict) or set(result) != {'body_hash','consent'} or result['body_hash'] != sha256(canonical(payload['body'])).hexdigest():
            raise ValueError('placement_consent_response_mismatch')
        return result
    if operation == 'probe':
        if set(payload) != {'challenge'} or result != {'challenge': payload['challenge'], 'alive': True}:
            raise ValueError('probe_response_mismatch')
        return result
    if operation == 'account-get':
        from .directory import verify_account_result
        return verify_account_result(result, verifier.network, payload['user_id'], payload['version'], payload['confirmed'], committee)
    if operation == 'account-put':
        from .directory import validate_record
        body, digest = validate_record(payload['record'], verifier.network)
        if result != {'user_id': body['user_id'], 'version': body['version'], 'record_hash': digest, 'stored': True}:
            raise ValueError('account_receipt_mismatch')
        return result
    if operation == 'account-confirm':
        # This is only a delivery receipt, never proof of network consensus.
        from .certificates import statement
        certificate = payload['certificate']
        if committee is None or result != {'confirmed': True, 'height': certificate['height'], 'checkpoint_hash': sha256(statement(committee, certificate['height'], certificate['previous'], certificate['checkpoint'])).hexdigest()}:
            raise ValueError('checkpoint_receipt_mismatch')
        return result
    if result == {"error": "not_found"} and operation == "get":
        return result
    if result.get("digest") != payload.get("digest"):
        raise ValueError("unexpected_digest")
    if operation == "get":
        ciphertext = result.get("ciphertext")
        if not isinstance(ciphertext, str) or sha256(bytes.fromhex(ciphertext)).hexdigest() != payload["digest"]:
            raise ValueError("corrupt_response")
    elif result.get("stored") is not True:
        raise ValueError("invalid_receipt")
    return result
