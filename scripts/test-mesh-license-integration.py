"""Optional cross-repository HTTP check using ONLY a fresh in-memory test DB.

Requires the private commercial checkout next to the core checkout. No production
configuration, customer account or activation key is used.
"""
import io
import os
from pathlib import Path
import sys
import tempfile
import threading
from unittest.mock import patch
from wsgiref.simple_server import make_server, WSGIRequestHandler

ROOT = Path(__file__).resolve().parents[1]
COMMERCIAL = ROOT / 'commercial-service'
if not (COMMERCIAL / 'manage.py').is_file():
    raise SystemExit('Private commercial checkout required for this optional test')
sys.path[:0] = [str(COMMERCIAL), str(ROOT / 'django-server' / 'sfera_server')]
os.environ['DJANGO_SETTINGS_MODULE'] = 'service.settings'
os.environ['COMMERCIAL_DEBUG'] = '1'
os.environ['COMMERCIAL_SECRET_KEY'] = 'in-memory-cross-repository-test-only'
os.environ['COMMERCIAL_ALLOWED_HOSTS'] = '127.0.0.1,localhost'
# No inherited DB host may select a real database in this test process.
os.environ.pop('COMMERCIAL_DB_HOST', None)
import django
django.setup()
from django.conf import settings
from django.core.management import call_command
from django.core.wsgi import get_wsgi_application
from django.test.utils import setup_databases, teardown_databases
from django.utils import timezone
from datetime import timedelta
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from hashlib import sha256
from licensing.models import Instance, Subscription
from sfera_mesh.license_client import request_attestation
from sfera_modules.commercial import CommercialError

from django.db import connections
assert connections['default'].settings_dict['ENGINE'] == 'django.db.backends.sqlite3'
connections['default'].settings_dict['TEST']['NAME'] = ':memory:'
databases = setup_databases(verbosity=0, interactive=False)
class Quiet(WSGIRequestHandler):
    def log_message(self, *args):
        pass
try:
    with tempfile.TemporaryDirectory() as folder:
        settings.COMMERCIAL_MESH_SIGNING_KEY_FILE = str(Path(folder) / 'issuer.key')
        call_command('bootstrap_mesh_issuer', stdout=io.StringIO())
        issuer = Ed25519PrivateKey.from_private_bytes(Path(settings.COMMERCIAL_MESH_SIGNING_KEY_FILE).read_bytes()).public_key().public_bytes_raw()
        trusted = {sha256(issuer).hexdigest(): issuer}
        instance = Instance(name='in-memory-cross-repo-test')
        token = instance.issue_key()
        subscription = Subscription.objects.create(instance=instance, module_id='office', status='active', expires_at=timezone.now() + timedelta(hours=1))
        node = Ed25519PrivateKey.generate()
        server = make_server('127.0.0.1', 0, get_wsgi_application(), handler_class=Quiet)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            endpoint = 'http://127.0.0.1:' + str(server.server_port)
            with patch('sfera_mesh.license_client.config', return_value=(endpoint, str(instance.id), token)):
                _, verified = request_attestation(node, 'integration-test', trusted)
                assert verified.modules == frozenset({'office'})
                subscription.status = 'revoked'
                subscription.save()
                _, verified = request_attestation(node, 'integration-test', trusted)
                assert verified.modules == frozenset()
                try:
                    request_attestation(Ed25519PrivateKey.generate(), 'integration-test', trusted)
                except CommercialError:
                    pass
                else:
                    raise AssertionError('Node identity was rebound')
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
finally:
    teardown_databases(databases, verbosity=0)
print('PASS: core client -> real commercial HTTP API -> issuer signature verification, revocation and binding conflict (in-memory database).')
