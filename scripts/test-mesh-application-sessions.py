"""Isolated SQLite/DRF/Channels integration. Never opens the installed app DB."""
from datetime import timedelta
from pathlib import Path
import asyncio
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'django-server' / 'sfera_server'))
folder = tempfile.TemporaryDirectory()
from django.conf import settings
settings.configure(
    SECRET_KEY='isolated-mesh-session-test-only-32-bytes', USE_TZ=True,
    APP_USER_AGENT_TOKEN='SferaTestApp', APP_REFRESH_TOKEN_LIFETIME=timedelta(days=30),
    INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'sfera_auth', 'rest_framework_simplejwt.token_blacklist'],
    DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': str(Path(folder.name) / 'app.sqlite')}},
    AUTH_USER_MODEL='sfera_auth.User',
    REST_FRAMEWORK={'DEFAULT_AUTHENTICATION_CLASSES': ['sfera_auth.mesh_sessions.MeshJWTAuthentication'],
                    'DEFAULT_THROTTLE_RATES': {'auth': '1000/min'}},
    SIMPLE_JWT={'ACCESS_TOKEN_LIFETIME': timedelta(minutes=5), 'REFRESH_TOKEN_LIFETIME': timedelta(days=1), 'ROTATE_REFRESH_TOKENS': True, 'BLACKLIST_AFTER_ROTATION': True},
    REFRESH_COOKIE_NAME='refresh', REFRESH_COOKIE_SECURE=False, REFRESH_COOKIE_SAMESITE='Strict', REFRESH_COOKIE_PATH='/api/auth/',
)
import django
django.setup()
from django.db import connection
from sfera_auth.models import User, UserBan, SecurityAuditLog, UserDevice
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken, BlacklistedToken
with connection.schema_editor() as editor:
    for model in (User, UserBan, SecurityAuditLog, UserDevice, OutstandingToken, BlacklistedToken):
        editor.create_model(model)

from rest_framework.test import APIRequestFactory
from rest_framework_simplejwt.tokens import RefreshToken, AccessToken
from rest_framework_simplejwt.exceptions import TokenError
from sfera_auth import mesh_views, mesh_sessions, views, bans
from sfera_mesh.application_sessions import ApplicationSessions
from sfera_mesh.test_application_sessions import Directory
from sfera_mesh.devices import DOMAIN, device_id, verify_event
from sfera_mesh.directory import user_id, ZERO
from sfera_mesh.storage import canonical
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


class FreshDirectory(Directory):
    def anchor(self):
        if not self.available:
            from sfera_mesh.consensus_directory import ConsensusUnavailable
            raise ConsensusUnavailable('offline')
        return {'expires_at': int(time.time()) + 30}

    def device_history(self, identity):
        value = super().device_history(identity)
        value['finality']['expires_at'] = int(time.time()) + 30
        return value


class SessionFixture(unittest.TestCase):
    def setUp(self):
        import uuid
        self.user = User.objects.create(username=uuid.uuid4().hex)
        self.owner, self.device = Ed25519PrivateKey.generate(), Ed25519PrivateKey.generate()
        self.directory = FreshDirectory(self.owner)
        self.owner_id = user_id(bytes.fromhex(self.directory.owner))
        self.did = device_id(self.device.public_key().public_bytes_raw())
        from sfera_mesh.identity import node_id
        self.entry_key = Ed25519PrivateKey.generate()
        self.entry = node_id(self.entry_key.public_key().public_bytes_raw())
        self.backend = ApplicationSessions(str(Path(folder.name) / (self.user.username + '.sqlite')), self.directory, self.entry, entry_key=self.entry_key)
        self.addCleanup(self.backend.close)
        self.event('enroll')
        self.patch = patch.object(mesh_sessions, 'sessions', return_value=self.backend)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.patch2 = patch.object(mesh_views, 'sessions', return_value=self.backend)
        self.patch2.start()
        self.addCleanup(self.patch2.stop)
        self.factory = APIRequestFactory()
        self.refresh = RefreshToken.for_user(self.user)
        self.access = str(self.refresh.access_token)

    def event(self, operation):
        events = self.directory.events
        body = {'domain': DOMAIN, 'network': 'lab', 'user_id': self.owner_id,
                'version': len(events)+1, 'previous': verify_event(events[-1], 'lab', self.directory.owner)[1] if events else ZERO,
                'operation': operation, 'device_id': self.did, 'device_public': self.device.public_key().public_bytes_raw().hex()}
        events.append({'body': body, 'owner_signature': self.owner.sign(canonical(body)).hex(),
                       'device_signature': self.device.sign(canonical(body)).hex() if operation == 'enroll' else ''})

    def request(self, view, data, access=None, cookie=None):
        kwargs = {'HTTP_AUTHORIZATION': 'Bearer ' + (access or self.access)}
        if cookie is not None:
            kwargs['HTTP_COOKIE'] = 'refresh=' + cookie
        request = self.factory.post('/api/auth/mesh/', data, format='json', **kwargs)
        return view(request)

    def bind(self):
        result = self.request(mesh_views.challenge, {'owner': self.owner_id, 'device': self.did})
        self.assertEqual(result.status_code, 200, result.data)
        body = result.data
        response = self.request(mesh_views.bind, {'challenge': body['challenge'],
            'owner_signature': self.owner.sign(canonical(body)).hex(),
            'device_signature': self.device.sign(canonical(body)).hex()}, cookie=str(self.refresh))
        self.assertEqual(response.status_code, 200, response.data)
        return response

class EntryProbeTests(SessionFixture):
    def test_anonymous_probe_binds_nonce_genesis_and_entry_key(self):
        result = self.request(mesh_views.entry_probe, {'nonce': 'c'*64})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result['Cache-Control'], 'no-store')
        self.assertEqual(result.data['body']['nonce'], 'c'*64)
        self.assertEqual(result.data['body']['entry'], self.entry)
        self.assertEqual(result.data['body']['genesis'], self.directory.pin)
        self.entry_key.public_key().verify(bytes.fromhex(result.data['signature']), canonical(result.data['body']))
        self.assertNotIn('access', result.data)

    def test_invalid_probe_and_missing_identity_fail_closed(self):
        for data in ({'nonce': 'bad'}, {'nonce': 'c'*64, 'public_key': 'd'*64}):
            self.assertEqual(self.request(mesh_views.entry_probe, data).status_code, 503)
        self.backend.entry_key = None
        self.assertEqual(self.request(mesh_views.entry_probe, {'nonce': 'c'*64}).status_code, 503)

    def test_probe_needs_fresh_consensus(self):
        self.directory.available = False
        self.assertEqual(self.request(mesh_views.entry_probe, {'nonce': 'c'*64}).status_code, 503)


class IntegrationTests(SessionFixture):
    def test_portable_entry_signed_binding_approval_and_device_login(self):
        response = self.request(mesh_views.challenge, {'owner':self.owner_id,'device':self.did,'signed':True})
        self.assertEqual(response.status_code,200,response.data)
        self.assertEqual(response['Cache-Control'],'no-store')
        proof=response.data
        self.entry_key.public_key().verify(bytes.fromhex(proof['signature']),canonical(proof['body']))
        self.assertEqual(proof['body']['domain'],'sfera-mesh-binding-request-v1')
        self.assertEqual(proof['body']['controller_public'],self.directory.owner)
        body=proof['body']['challenge']
        response=self.request(mesh_views.bind,{'challenge':body['challenge'],'owner_signature':self.owner.sign(canonical(body)).hex(),
            'device_signature':self.device.sign(canonical(body)).hex()},cookie=str(self.refresh))
        self.assertEqual(response.status_code,200,response.data)
        bound=AccessToken(response.data['access'])['mesh_session']
        self.assertEqual(bound['device'],self.did)
        challenge=self.backend.login_challenge(self.owner_id,self.did)
        claim=self.backend.complete(str(self.user.pk),challenge['login_jti'],challenge['challenge'],'',
            self.device.sign(canonical(challenge)).hex(),int(time.time())+60,purpose='login')
        self.backend.require(str(self.user.pk),claim)
        self.assertEqual(self.request(mesh_views.challenge,{'owner':self.owner_id,'device':self.did,'signed':False},access=response.data['access']).status_code,400)

    def test_real_jwt_cookie_rotation_revocation_and_refresh(self):
        response = self.bind()
        access = response.data['access']
        cookie = response.cookies['refresh'].value
        self.assertEqual(AccessToken(access)['mesh_session'], RefreshToken(cookie)['mesh_session'])
        with self.assertRaises(TokenError):
            RefreshToken(str(self.refresh))
        result = self.request(views.refresh_token, {}, access=access, cookie=cookie)
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(AccessToken(result.data['access'])['mesh_session'], AccessToken(access)['mesh_session'])
        rotated = result.cookies['refresh'].value
        self.event('revoke')
        # No bearer at refresh time: a cookie alone still cannot bypass revoke.
        request = self.factory.post('/api/auth/refresh/', {}, format='json', HTTP_COOKIE='refresh='+rotated)
        result = views.refresh_token(request)
        self.assertEqual(result.status_code, 401, result.data)
        self.assertEqual(self.request(mesh_views.challenge, {}, access=access).status_code, 401)
        # Independent password sessions continue to use the existing policy.
        self.assertEqual(self.request(mesh_views.challenge, {}).status_code, 400)

    def test_module_guard_and_ban_cannot_bind(self):
        with patch('sfera_modules.hooks.access_block', return_value={'error': 'second_factor_required'}):
            self.assertEqual(self.request(mesh_views.challenge, {'owner': self.owner_id, 'device': self.did}).status_code, 403)
        with patch.object(bans, 'is_banned', return_value=True):
            self.assertEqual(self.request(mesh_views.challenge, {'owner': self.owner_id, 'device': self.did}).status_code, 403)

    def test_unbind_works_without_consensus(self):
        response = self.bind()
        self.directory.available = False
        result = self.request(mesh_views.unbind, {}, access=response.data['access'])
        self.assertEqual(result.status_code, 204)
        self.directory.available = True
        self.assertEqual(self.request(mesh_views.challenge, {}, access=response.data['access']).status_code, 401)

    def test_normal_logout_revokes_bound_session_without_consensus(self):
        response = self.bind()
        self.directory.available = False
        result = self.request(views.logout_view, {}, access=response.data['access'], cookie=response.cookies['refresh'].value)
        self.assertEqual(result.status_code, 204)
        self.directory.available = True
        self.assertEqual(self.request(mesh_views.challenge, {}, access=response.data['access']).status_code, 401)

    def test_outage_is_retryable_and_does_not_rotate_cookie(self):
        from sfera_mesh.consensus_directory import ConsensusUnavailable
        response = self.bind()
        cookie = response.cookies['refresh'].value
        with patch.object(mesh_sessions, 'sessions', side_effect=mesh_sessions.MeshUnavailable()):
            request = self.factory.post('/api/auth/refresh/', {}, format='json', HTTP_COOKIE='refresh='+cookie)
            result = views.refresh_token(request)
            self.assertEqual(result.status_code, 503)
            self.assertNotIn('refresh', result.cookies)
        RefreshToken(cookie)  # It has not been blacklisted by a failed refresh.
        with patch.object(bans, 'is_banned', return_value=True):
            self.assertEqual(self.request(mesh_views.challenge, {}, access=response.data['access']).status_code, 401)

    def test_missing_or_foreign_cookie_cannot_consume_binding(self):
        result = self.request(mesh_views.challenge, {'owner': self.owner_id, 'device': self.did})
        body = result.data
        data = {'challenge': body['challenge'], 'owner_signature': self.owner.sign(canonical(body)).hex(),
                'device_signature': self.device.sign(canonical(body)).hex()}
        self.assertEqual(self.request(mesh_views.bind, data).status_code, 401)
        other = User.objects.create(username='foreign-'+self.user.username)
        self.assertEqual(self.request(mesh_views.bind, data, cookie=str(RefreshToken.for_user(other))).status_code, 401)
        response = self.request(mesh_views.bind, data, cookie=str(self.refresh))
        self.assertEqual(response.status_code, 200)

    def test_channels_drops_outbound_after_revoke(self):
        from sfera_server.middleware import JWTAuthMiddleware
        response = self.bind()
        sent = []
        async def application(scope, receive, send):
            self.assertTrue(scope['user'].is_authenticated)
            await send({'type': 'websocket.accept'})
            self.event('revoke')
            # Even a frame resembling a ban notice must not bypass a device
            # revoke when this application account is not actually blocked.
            await send({'type': 'websocket.send', 'text': '{"type":"account_banned","reason":"must never reach the socket"}'})
        async def receive():
            return {'type': 'websocket.connect'}
        async def send(event):
            sent.append(event)
        asyncio.run(JWTAuthMiddleware(application)({'type': 'websocket', 'subprotocols': ['ionik.jwt', response.data['access']]}, receive, send))
        self.assertEqual(sent, [{'type': 'websocket.accept'}, {'type': 'websocket.close', 'code': 4003}])


class CipherApiTests(SessionFixture):
    def setUp(self):
        super().setUp()
        from django.test import override_settings
        from sfera_auth import cipher_views
        self.cipher_views = cipher_views
        setting = override_settings(SFERA_MESH_CIPHER_AUTHORITY=True)
        setting.enable(); self.addCleanup(setting.disable)
        mocked = patch.object(cipher_views, 'sessions', return_value=self.backend)
        mocked.start(); self.addCleanup(mocked.stop)

    def certificate(self, key=None):
        import base64
        from sfera_mesh.cipher_authority import DOMAIN as CIPHER_DOMAIN
        key = key or self.device
        body = {'domain': CIPHER_DOMAIN, 'network': 'lab', 'genesis': self.directory.pin,
            'owner': self.owner_id, 'device': device_id(key.public_key().public_bytes_raw()),
            'device_public': key.public_key().public_bytes_raw().hex(),
            'ed25519': base64.b64encode(Ed25519PrivateKey.generate().public_key().public_bytes_raw()).decode().rstrip('='),
            'curve25519': base64.b64encode(Ed25519PrivateKey.generate().public_key().public_bytes_raw()).decode().rstrip('=')}
        return {'body': body, 'signature': key.sign(canonical(body)).hex()}

    def test_cipher_registration_requires_bound_session_and_preserves_pin(self):
        certificate = self.certificate()
        self.assertEqual(self.request(self.cipher_views.device, {'certificate': certificate}).status_code, 409)
        access = self.bind().data['access']
        response = self.request(self.cipher_views.device, {'certificate': certificate}, access=access)
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response['Cache-Control'], 'no-store')
        self.assertEqual(self.request(self.cipher_views.device, {'certificate': certificate}, access=access).data, response.data)
        self.assertEqual(self.request(self.cipher_views.device, {'certificate': self.certificate()}, access=access).status_code, 409)
        self.event('revoke')
        self.assertEqual(self.request(self.cipher_views.device, {'certificate': certificate}, access=access).status_code, 401)

    def test_cipher_feature_disabled_and_client_roster_is_rejected(self):
        import uuid
        from django.test import override_settings
        access = self.bind().data['access']
        with override_settings(SFERA_MESH_CIPHER_AUTHORITY=False):
            self.assertEqual(self.request(self.cipher_views.device, {}, access=access).status_code, 404)
        with patch.object(self.cipher_views, 'scope_members') as members:
            response = self.request(self.cipher_views.scope, {'source': 'dm', 'scope': str(uuid.uuid4()),
                'nonce': 'a'*64, 'members': [str(self.user.pk)]}, access=access)
        self.assertEqual(response.status_code, 409); members.assert_not_called()

    def test_scope_proof_uses_server_acl_and_all_active_devices(self):
        import uuid
        from hashlib import sha256
        access = self.bind().data['access']
        certificate = self.certificate()
        self.assertEqual(self.request(self.cipher_views.device, {'certificate': certificate}, access=access).status_code, 200)
        sibling = Ed25519PrivateKey.generate()
        events = self.directory.events
        body = {**events[0]['body'], 'version': 2, 'previous': verify_event(events[0], 'lab', self.directory.owner)[1],
            'device_id': device_id(sibling.public_key().public_bytes_raw()), 'device_public': sibling.public_key().public_bytes_raw().hex()}
        events.append({'body': body, 'owner_signature': self.owner.sign(canonical(body)).hex(),
            'device_signature': sibling.sign(canonical(body)).hex()})
        request = {'source': 'dm', 'scope': str(uuid.uuid4()), 'nonce': 'd'*64}
        with patch.object(self.cipher_views, 'scope_members', return_value=[str(self.user.pk)]) as acl:
            self.assertEqual(self.request(self.cipher_views.scope, request, access=access).status_code, 409)
            challenge = self.backend.challenge(str(self.user.pk), 'sibling', self.owner_id, body['device_id'])
            claim = self.backend.complete(str(self.user.pk), 'sibling', challenge['challenge'],
                self.owner.sign(canonical(challenge)).hex(), sibling.sign(canonical(challenge)).hex(), int(time.time()) + 300)
            token = AccessToken.for_user(self.user); token['mesh_session'] = claim
            self.assertEqual(self.request(self.cipher_views.device, {'certificate': self.certificate(sibling)}, access=str(token)).status_code, 200)
            result = self.request(self.cipher_views.scope, request, access=access)
        self.assertEqual(result.status_code, 200, result.data)
        acl.assert_called_with(self.user, 'dm', request['scope'])
        self.assertEqual(len(result.data['body']['certificates']), 2)
        self.entry_key.public_key().verify(bytes.fromhex(result.data['signature']), canonical(result.data['body']))
        self.assertEqual(result['Cache-Control'], 'no-store')


class KeyLoginTests(SessionFixture):
    def setUp(self):
        super().setUp()
        guard = patch('sfera_modules.hooks.login_block', return_value=None)
        guard.start()
        self.addCleanup(guard.stop)

    def anonymous(self, view, body):
        return view(self.factory.post('/api/auth/mesh/login/', body, format='json'))

    def proof(self):
        result = self.anonymous(mesh_views.login_challenge, {'owner': self.owner_id, 'device': self.did})
        self.assertEqual(result.status_code, 200, result.data)
        body = result.data
        self.assertEqual(body['domain'], 'sfera-mesh-application-login-v1')
        return {'challenge': body['challenge'], 'owner_signature': '',
                'device_signature': self.device.sign(canonical(body)).hex()}

    def test_key_login_requires_previous_authenticated_binding(self):
        response = self.anonymous(mesh_views.login_challenge, {'owner': self.owner_id, 'device': self.did})
        self.assertEqual(response.status_code, 400)
        self.bind()
        proof = self.proof()
        response = self.anonymous(mesh_views.login, proof)
        self.assertEqual(response.status_code, 200, response.data)
        claim = AccessToken(response.data['access'])['mesh_session']
        cookie = response.cookies['refresh'].value
        self.assertEqual(RefreshToken(cookie)['mesh_session'], claim)
        self.assertEqual(self.anonymous(mesh_views.login, proof).status_code, 400)
        self.event('revoke')
        self.assertEqual(self.request(mesh_views.challenge, {}, access=response.data['access']).status_code, 401)

    def test_key_login_preserves_second_factor_and_consumes_it_once(self):
        self.bind()
        with patch('sfera_modules.hooks.login_block', return_value={
                'error': 'second_factor_required', 'challenge': 'private-module-challenge', 'method': 'totp'}):
            response = self.anonymous(mesh_views.login, self.proof())
        self.assertEqual(response.status_code, 409, response.data)
        self.assertNotIn('access', response.data)
        opaque = response.data['challenge']
        self.assertTrue(opaque.startswith('mesh-'))
        self.assertNotIn('private-module-challenge', str(response.data))
        with patch('sfera_modules.hooks.second_factor_user', return_value=None):
            self.assertEqual(self.anonymous(mesh_views.login_second_factor, {'challenge': opaque, 'code': 'wrong'}).status_code, 401)
        with patch('sfera_modules.hooks.second_factor_user', return_value=self.user) as check:
            result = self.anonymous(mesh_views.login_second_factor, {'challenge': opaque, 'code': '123456'})
            self.assertEqual(result.status_code, 200, result.data)
            self.assertEqual(check.call_args.args[:2], ('private-module-challenge', '123456'))
            self.assertIn('mesh_session', AccessToken(result.data['access']))
            self.assertEqual(self.anonymous(mesh_views.login_second_factor, {'challenge': opaque, 'code': '123456'}).status_code, 400)

    def test_key_login_factor_cannot_switch_user_or_survive_device_revoke(self):
        self.bind()
        with patch('sfera_modules.hooks.login_block', return_value={'error': 'second_factor_required', 'challenge': 'hidden'}):
            response = self.anonymous(mesh_views.login, self.proof())
        opaque = response.data['challenge']
        other = User.objects.create(username='other-factor-'+self.user.username)
        with patch('sfera_modules.hooks.second_factor_user', return_value=other):
            self.assertEqual(self.anonymous(mesh_views.login_second_factor, {'challenge': opaque, 'code': '123456'}).status_code, 401)
        self.event('revoke')
        with patch('sfera_modules.hooks.second_factor_user', return_value=self.user) as check:
            self.assertEqual(self.anonymous(mesh_views.login_second_factor, {'challenge': opaque, 'code': '123456'}).status_code, 400)
            check.assert_not_called()

    def test_key_login_blocks_disabled_banned_and_module_denied(self):
        self.bind()
        proof = self.proof()
        with patch.object(bans, 'is_banned', return_value=True):
            self.assertEqual(self.anonymous(mesh_views.login, proof).status_code, 403)
        with patch('sfera_modules.hooks.access_block', return_value={'error': 'family_blocked'}):
            self.assertEqual(self.anonymous(mesh_views.login, proof).status_code, 403)
        with patch('sfera_modules.hooks.login_block', return_value={'error': 'denied'}):
            self.assertEqual(self.anonymous(mesh_views.login, proof).status_code, 403)

    def test_bound_refresh_never_extends_original_expiry(self):
        response = self.bind()
        cookie = RefreshToken(response.cookies['refresh'].value)
        cookie['exp'] = int(time.time()) + 45
        result = self.request(views.refresh_token, {}, cookie=str(cookie))
        self.assertEqual(result.status_code, 200, result.data)
        self.assertLessEqual(AccessToken(result.data['access'])['exp'], cookie['exp'])
        self.assertLessEqual(RefreshToken(result.cookies['refresh'].value)['exp'], cookie['exp'])


if __name__ == '__main__':
    try:
        result = unittest.main(exit=False)
    finally:
        connection.close()
        folder.cleanup()
    sys.exit(not result.result.wasSuccessful())
