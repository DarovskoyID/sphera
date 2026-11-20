"""Disposable DRF message transport fixture; never uses installed settings/DB."""
from contextlib import ExitStack
from pathlib import Path
import inspect
import tempfile
from unittest.mock import patch


class MessageApiFixture:
    def __init__(self, backend, people, *, live_fanout=None, guilds=False, binding=False):
        from cryptography.fernet import Fernet
        from django.conf import settings
        self.folder = tempfile.TemporaryDirectory()
        self.stack = ExitStack()
        self.backend, self.events, self.notifications = backend, [], []
        settings.configure(SECRET_KEY='isolated-cipher-message-fixture-only-key', USE_TZ=True,
            INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'sfera_auth', 'sfera_messages'] + (['sfera_modules', 'sfera_servers'] if guilds else []) + (['rest_framework_simplejwt.token_blacklist'] if binding else []),
            DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': str(Path(self.folder.name) / 'app.sqlite')}},
            AUTH_USER_MODEL='sfera_auth.User', MESSAGE_ENCRYPTION_KEY=Fernet.generate_key().decode(),
            SFERA_MESH_CIPHER_AUTHORITY=True, SFERA_MESH_CIPHER_MESSAGES=True,
            SFERA_MESH_GUILD_CIPHER_MESSAGES=guilds, SFERA_LICENSE_ENFORCE=False, ROOT_URLCONF='sfera_messages.urls',
            REST_FRAMEWORK={'DEFAULT_AUTHENTICATION_CLASSES': ['sfera_auth.mesh_sessions.MeshJWTAuthentication'],
                'DEFAULT_THROTTLE_RATES': {'auth': '120/min'}})
        if binding:
            from datetime import timedelta
            settings.SIMPLE_JWT = {'ACCESS_TOKEN_LIFETIME': timedelta(minutes=30), 'REFRESH_TOKEN_LIFETIME': timedelta(hours=1)}
            settings.APP_USER_AGENT_TOKEN = 'SphereDisposableNativeFixture'
            settings.APP_REFRESH_TOKEN_LIFETIME = timedelta(hours=1)
            settings.REFRESH_COOKIE_NAME = 'fixture_refresh'
            settings.REFRESH_COOKIE_PATH = '/api/auth/'
            settings.REFRESH_COOKIE_SECURE = True
            settings.REFRESH_COOKIE_SAMESITE = 'Lax'
        if guilds:
            import sys
            import logging
            logger = logging.getLogger('sfera_servers.cipher_views')
            logger.setLevel(logging.DEBUG)
            logger.addHandler(logging.StreamHandler())
            sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'django-server' / 'sfera_server' / 'local_workspaces' / 'servers' / 'backend'))
        import django
        django.setup()
        from django.apps import apps
        from django.db import connection
        with connection.schema_editor() as editor:
            for app in ('sfera_auth', 'sfera_messages') + (('sfera_modules', 'sfera_servers') if guilds else ()) + (('token_blacklist',) if binding else ()):
                for model in apps.get_app_config(app).get_models():
                    editor.create_model(model)
            from sfera_messages.cipher_mode import install
            install(apps, editor)
            if guilds:
                from sfera_servers.cipher_messages import install as install_guild
                install_guild(apps, editor)
        from sfera_auth import mesh_sessions, cipher_views
        from sfera_auth.models import User
        self.users = {person['user']: User.objects.create(pk=person['user'], username=person['user']) for person in people}
        for target in (mesh_sessions, cipher_views):
            self.stack.enter_context(patch.object(target, 'sessions', return_value=backend))
        self.stack.enter_context(patch('sfera_messages.services._fanout', side_effect=live_fanout or (lambda *args: self.events.append(args))))
        self.stack.enter_context(patch('sfera_messages.services._fanout_user_notifs', side_effect=lambda *args: self.notifications.append(args)))

    def conversation(self, scope, members):
        from sfera_messages.models import Conversation
        value, _ = Conversation.objects.get_or_create(pk=scope)
        value.participants.set([self.users[user] for user in members])
        return value

    def token(self, user, claim):
        from rest_framework_simplejwt.tokens import AccessToken
        token = AccessToken.for_user(self.users[user]); token['mesh_session'] = claim
        return str(token)

    def request(self, user, claim, scope, wire=None, *, method='post', data=None, authorization=None, action='send'):
        from rest_framework.test import APIRequestFactory
        from django.urls import resolve
        authorization = authorization or 'Bearer ' + self.token(user, claim)
        route = '/conversations/' + scope + '/messages/' + ('cipher/' + action + '/' if method == 'post' else '')
        factory = APIRequestFactory()
        request = getattr(factory, method)(route, data if data is not None else ({'cipher': wire} if wire else {}),
            format='json', HTTP_AUTHORIZATION=authorization)
        match = resolve(route)
        # Bypass only the par() thread-pool wrapper; retain the complete DRF
        # authentication/permission dispatch, without starting an ASGI server.
        view = match.func.__wrapped__ if inspect.iscoroutinefunction(match.func) else match.func
        response = view(request, **match.kwargs)
        return {'status': response.status_code, 'body': response.data}

    def guild_conversation(self, guild, scope, members):
        from sfera_servers.models import Guild, GuildChannel, GuildMembership
        value, _ = Guild.objects.get_or_create(pk=guild, defaults={'owner_id': members[0], 'name': 'Isolated cipher Guild', 'is_discoverable': False})
        for index, user in enumerate(members):
            GuildMembership.objects.get_or_create(guild=value, user_id=user, defaults={'role': 'owner' if index == 0 else 'member'})
        return GuildChannel.objects.get_or_create(pk=scope, defaults={'guild': value, 'name': 'cipher'})[0]

    def guild_request(self, user, claim, guild, scope, *, data=None, authorization=None, action='send', method='post'):
        from rest_framework.test import APIRequestFactory
        from django.urls import resolve
        route = f'/guilds/{guild}/channels/{scope}/messages/' + ('cipher/' + action + '/' if method == 'post' else '')
        request = getattr(APIRequestFactory(), method)(route, data or {}, format='json',
            HTTP_AUTHORIZATION=authorization or 'Bearer ' + self.token(user, claim))
        match = resolve(route, urlconf='sfera_servers.urls')
        view = match.func.__wrapped__ if inspect.iscoroutinefunction(match.func) else match.func
        response = view(request, **match.kwargs)
        return {'status': response.status_code, 'body': response.data}

    def enable_delivery(self):
        from django.test import override_settings
        from django.db import connection
        with connection.cursor() as cursor:
            cursor.execute('PRAGMA synchronous=FULL')
        self.stack.enter_context(override_settings(SFERA_MESH_MESSAGE_CLUSTER='c'*64,
            SFERA_MESH_MESSAGE_GENESIS=self.backend.directory.pin, SFERA_MESH_MESSAGE_DELIVERY=True))

    def confirm_delivery(self):
        import importlib.util
        from sfera_messages.mesh_publication import publish_batch
        from sfera_messages.mesh_delivery import dispatch_confirmed
        path = Path(__file__).resolve().parent / 'test-mesh-message-publication.py'
        spec = importlib.util.spec_from_file_location('outbox_delivery_model', path)
        fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)
        writer = fixture.MemoryWriter(self.backend.directory.pin)
        publish_batch(writer)
        result = []
        count = dispatch_confirmed(writer, emit=lambda *args: result.append(args[1]))
        return {'count': count, 'messages': result}

    def close(self):
        from django.db import connection
        self.stack.close(); connection.close(); self.folder.cleanup()
