"""Isolated loopback HTTP replication lab. Not a public production endpoint.

Authenticated peers can store/fetch immutable ciphertext. No signing authority,
licence inheritance, account login or consensus acknowledgement is exposed.
"""
import json
import sqlite3
import threading
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from .identity import MAX_BYTES, envelope, node_id
from .storage import canonical


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class BlobStore:
    def __init__(self, path):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS blobs (digest TEXT PRIMARY KEY, data BLOB NOT NULL)")
        self.lock = threading.Lock()

    def close(self):
        self.db.close()

    def execute(self, operation, payload):
        if not isinstance(payload, dict):
            raise ValueError("invalid_payload")
        if operation == "put" and set(payload) == {"digest", "ciphertext"}:
            if not isinstance(payload["ciphertext"], str) or len(payload["ciphertext"]) > 524288:
                raise ValueError("invalid_ciphertext")
            data = bytes.fromhex(payload["ciphertext"])
            digest = sha256(data).hexdigest()
            if not data or digest != payload["digest"]:
                raise ValueError("digest_mismatch")
            with self.lock, self.db:
                self.db.execute("INSERT OR IGNORE INTO blobs VALUES (?, ?)", (digest, data))
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

    def __init__(self, key, verifier, store, directory=None, auth=None):
        self.key, self.verifier, self.store = key, verifier, store
        self.directory, self.auth = directory, auth
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
        if self.path not in tuple("/mesh-lab/v1/" + name for name in ("put", "get", "account-put", "account-get", "account-confirm")):
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
            if operation.startswith('account-'):
                if self.server.directory is None:
                    raise ValueError('directory_unavailable')
                result = self.server.directory.execute(operation, payload)
            else:
                result = self.server.store.execute(operation, payload)
            response = envelope(self.server.key, self.server.verifier.network, sender, operation + "-response", {"request_nonce": request["record"]["nonce"], "result": result})
            body = canonical(response)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (ValueError, TypeError, KeyError, UnicodeError):
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


def exchange(endpoint, key, verifier, recipient, operation, payload, *, committee=None):
    # Laboratory only: no remote URL supplied by a peer is ever followed.
    from urllib.parse import urlsplit
    url = urlsplit(endpoint)
    if url.scheme != "http" or url.hostname != "127.0.0.1" or url.username or url.password or url.path or url.query or url.fragment:
        raise ValueError("loopback_lab_only")
    if operation not in ("get", "put", "account-put", "account-get", "account-confirm"):
        raise ValueError("unsupported_operation")
    if operation == 'account-confirm':
        from .directory import validate_directory_certificate
        if committee is None or committee.network != verifier.network:
            raise ValueError('no_trusted_committee')
        validate_directory_certificate(committee, payload['certificate'])
    signed = envelope(key, verifier.network, recipient, operation, payload)
    request = Request(endpoint + "/mesh-lab/v1/" + operation, data=canonical(signed), headers={"Content-Type": "application/json"}, method="POST")
    with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=3) as response:
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("response_too_large")
    sender, response = verifier.verify(json.loads(data), operation + "-response")
    if sender != recipient or not isinstance(response, dict) or response.get("request_nonce") != signed["record"]["nonce"]:
        raise ValueError("unexpected_responder_or_request")
    result = response.get("result")
    if not isinstance(result, dict):
        raise ValueError("invalid_result")
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
