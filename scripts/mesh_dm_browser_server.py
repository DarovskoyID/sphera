"""Disposable real Django HTTP/Channels server for the browser E2EE journey.

Only consensus-directory admission and the pubsub broker are local fixtures.
Never imports installed settings, uses installed data, or accepts real accounts.
"""
import asyncio
from datetime import datetime, timedelta, timezone
from ipaddress import ip_address
import json
from pathlib import Path
import socket
import sys
import threading
import types

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'django-server' / 'sfera_server'))
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa
from cryptography.x509.oid import NameOID
from sfera_mesh.application_sessions import ApplicationSessions
from sfera_mesh.identity import node_id
from sfera_mesh.test_cipher_authority import Directory
from mesh_cipher_message_fixture import MessageApiFixture


def main():
    setup = json.loads(sys.stdin.readline())
    directory, entry_key = Directory(), ed25519.Ed25519PrivateKey.generate()
    # The imported unit-test directory has a fixed synthetic timestamp. Live
    # HTTP challenges need a fresh lease; consensus itself is still simulated.
    history = directory.device_history
    def fresh_history(owner):
        result = history(owner)
        result['finality']['expires_at'] = int(datetime.now().timestamp()) + 25
        return result
    directory.device_history = fresh_history
    entry = node_id(entry_key.public_key().public_bytes_raw())
    backend = ApplicationSessions(':memory:', directory, entry, entry_key=entry_key)
    claims = {}
    for person in setup['users']:
        owner, device = person['event']['body']['user_id'], person['event']['body']['device_id']
        directory.owners[owner] = (person['owner_public'], person.get('events', [person['event']]))
        claim = dict(id=person['session'], owner=owner, device=device, genesis=directory.pin, entry=entry)
        with backend.db:
            if not person.get('unbound'):
                backend.db.execute('INSERT INTO app_identities VALUES(?,?)', (owner, person['user']))
            backend.db.execute('INSERT INTO app_sessions VALUES(?,?,?,?,?,0)',
                (claim['id'], person['user'], owner, device, int(datetime.now().timestamp()) + 3600))
        claims[person['user']] = claim
    event_loop = None

    def fanout(group, channel_event, _gateway):
        from channels.layers import get_channel_layer
        if event_loop is None:
            raise RuntimeError('browser_server_loop_missing')
        asyncio.run_coroutine_threadsafe(get_channel_layer().group_send(group, channel_event), event_loop).result(5)

    # Remember only this fixture's SQLite handles, including ASGI worker handles,
    # so Windows can remove its temporary database after the reactor stops.
    from django.db.backends.signals import connection_created
    opened_connections = []

    def remember_connection(sender, connection, **_kwargs):
        opened_connections.append(connection)

    connection_created.connect(remember_connection, weak=False)
    fixture = MessageApiFixture(backend, setup['users'], live_fanout=fanout, guilds=bool(setup.get('guild')), binding=bool(setup.get('binding')))
    from django.conf import settings
    import logging
    logging.getLogger('django.request').addHandler(logging.StreamHandler())
    from django.core.signals import got_request_exception
    def report_exception(**_kwargs):
        import traceback
        traceback.print_exc(file=sys.stderr)
    got_request_exception.connect(report_exception, weak=False)
    settings.ALLOWED_HOSTS = ['127.0.0.1', 'localhost']
    settings.CHANNEL_LAYERS = {'default': {'BACKEND': 'channels.layers.InMemoryChannelLayer'}}
    fixture.conversation(setup['scope'], list(claims)[:2])
    if setup.get('guild'):
        fixture.guild_conversation(setup['guild'], setup['scope'], list(claims))
    from unittest.mock import patch
    from sfera_auth import mesh_views
    fixture.stack.enter_context(patch.object(mesh_views, 'sessions', return_value=backend))
    from django.urls import path, include
    from django.http import JsonResponse
    from sfera_auth import cipher_views
    if setup.get('profile_guard'):
        # Explicit simulated consensus boundary for the browser journey. The
        # same records are separately exercised on four real BFT validators.
        from hashlib import sha256
        from sfera_mesh.storage import canonical
        from sfera_mesh.cipher_authority import CipherAuthority
        from sfera_mesh.cipher_profiles import verify_record
        settings.SFERA_MESH_CIPHER_PROFILE_GUARD = True
        backend.require_cipher_profile_guard = True
        import time
        def profile_anchor():
            if not directory.available: raise ValueError('fixture_directory_offline')
            return {'network':directory.network,'height':10,'header_hash':'1'*64,'validators_hash':'2'*64,'expires_at':int(time.time())+25}
        directory.anchor = profile_anchor
        directory.current = {'state': {'cipher_devices': {}, 'cipher_profiles': {}}}
        publish_device = CipherAuthority.publish
        def pinned_device(authority, user, claim, certificate, **kwargs):
            result = publish_device(authority, user, claim, certificate, **kwargs)
            with directory.lock:
                directory.current['state']['cipher_devices'][claim['owner']+':'+claim['device']] = {'certificate':certificate,'digest':sha256(canonical(certificate)).hexdigest()}
            return result
        fixture.stack.enter_context(patch.object(CipherAuthority, 'publish', pinned_device))
        def commit_profile(record):
            with directory.lock:
                state=directory.current['state']; digest=verify_record(record,state,directory.network,directory.pin)
                b=record['body']; key=b['owner']+':'+b['device']; old=state['cipher_profiles'].get(key)
                if old and old['digest']==digest:return
                if b['version']!=(old['record']['body']['version']+1 if old else 1) or b['previous']!=(old['digest'] if old else '0'*64):raise ValueError('fixture_profile_conflict')
                state['cipher_profiles'][key]={'record':record,'digest':digest}
        fixture.stack.enter_context(patch.object(cipher_views,'submit_account_record',commit_profile))
    from sfera_messages.models import Message
    from sfera_messages import views

    def health(_request):
        return JsonResponse({'ok': True})

    def control(request):
        # Explicit test-only control plane for admission and source SQL changes.
        # It exists only in this disposable fixture, behind a random test token.
        if not setup.get('control') or request.headers.get('X-Fixture-Control') != setup['control']:
            return JsonResponse({'error': 'forbidden'}, status=403)
        value = json.loads(request.body)
        if value['operation'] == 'event':
            with directory.lock:
                directory.owners[value['owner']][1].append(value['event'])
        elif value['operation'] == 'delete':
            Message.objects.filter(pk=value['id']).delete()
        elif value['operation'] == 'remove_member':
            from sfera_messages.models import Conversation
            Conversation.objects.get(pk=value['scope']).participants.remove(value['user'])
        else:
            return JsonResponse({'error': 'unknown'}, status=400)
        return JsonResponse({'ok': True})

    module = types.ModuleType('mesh_dm_browser_test_urls')
    module.urlpatterns = [path('health', health),
        path('test/control', control),
        path('api/auth/mesh/entry/', mesh_views.entry_probe),
        path('api/auth/mesh/challenge/', mesh_views.challenge),
        path('api/auth/mesh/bind/', mesh_views.bind),
        path('api/auth/mesh/login/challenge/', mesh_views.login_challenge),
        path('api/auth/mesh/login/', mesh_views.login),
        path('api/auth/mesh/login/2fa/', mesh_views.login_second_factor),
        path('api/auth/mesh/cipher/device/', cipher_views.device),
        path('api/auth/mesh/cipher/archive-device/', cipher_views.archive_device),
        path('api/auth/mesh/cipher/profile/', cipher_views.profile),
        path('api/auth/mesh/cipher/scope/', cipher_views.scope),
        path('api/auth/mesh/cipher/relay/', cipher_views.relay),
        path('api/ws/authorize/', views.ws_authorize), path('api/', include('sfera_messages.urls'))]
    if setup.get('guild'):
        module.urlpatterns.insert(-1, path('api/', include('sfera_servers.urls')))
    sys.modules[module.__name__] = module
    settings.ROOT_URLCONF = module.__name__
    from django.core.asgi import get_asgi_application
    from channels.routing import ProtocolTypeRouter, URLRouter
    from sfera_messages.consumers import ChatConsumer
    from sfera_server.middleware import JWTAuthMiddleware
    socket_patterns = [path('ws/chat/<uuid:conversation_id>/', ChatConsumer.as_asgi())]
    if setup.get('guild'):
        from sfera_servers.consumers import GuildChannelConsumer
        socket_patterns.append(path('ws/guild/<uuid:guild_id>/channel/<uuid:channel_id>/', GuildChannelConsumer.as_asgi()))
    app = ProtocolTypeRouter({'http': get_asgi_application(), 'websocket': JWTAuthMiddleware(URLRouter(socket_patterns))})

    async def application(scope, receive, send):
        nonlocal event_loop
        event_loop = asyncio.get_running_loop()
        await app(scope, receive, send)

    tls_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Disposable DM browser test')])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(tls_key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(hours=2))
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ip_address('127.0.0.1'))]), critical=False)
        .sign(tls_key, hashes.SHA256()))
    with socket.socket() as reserved:
        reserved.bind(('127.0.0.1', 0))
        port = reserved.getsockname()[1]
    payload = dict(port=port, pin=dict(network=directory.network, nodeId=entry,
        publicKey=entry_key.public_key().public_bytes_raw().hex(), url=setup['origin'], label='Disposable DM test'),
        users=[dict(user=user, token=fixture.token(user, claims[user])) for user in claims],
        cert=cert.public_bytes(serialization.Encoding.PEM).decode(),
        key=tls_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption()).decode())
    if setup.get('binding'):
        from rest_framework_simplejwt.tokens import RefreshToken
        for index, person in enumerate(setup['users']):
            if person.get('unbound'):
                refresh = RefreshToken.for_user(fixture.users[person['user']])
                payload['users'][index]['token'] = str(refresh.access_token)
                payload['users'][index]['refresh'] = str(refresh)
    print(json.dumps(payload), flush=True)
    from daphne.server import Server
    server = Server(application, endpoints=[f'tcp:port={port}:interface=127.0.0.1'], signal_handlers=True,
        verbosity=0)
    from twisted.internet import reactor

    def shutdown_on_eof():
        sys.stdin.read()
        reactor.callFromThread(reactor.stop)

    threading.Thread(target=shutdown_on_eof, daemon=True).start()
    try:
        server.run()
    finally:
        # Only this process's disposable fixture database is ever inspected.
        assert not Message.objects.exclude(message_type='cipher').exists()
        connection_created.disconnect(remember_connection)
        for connection in opened_connections:
            connection.inc_thread_sharing()
            try:
                connection.close()
            finally:
                connection.dec_thread_sharing()
        fixture.close()
        backend.close()


if __name__ == '__main__':
    main()
