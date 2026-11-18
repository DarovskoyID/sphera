import json
from types import SimpleNamespace
from unittest.mock import patch
from asgiref.sync import async_to_sync
from django.test import SimpleTestCase, RequestFactory, override_settings
from .commercial import CommercialError
from .local_workspaces import manifests
from .workspace_access import WorkspaceLicenseMiddleware
from .workspace_sockets import LicensedSocket


@override_settings(SFERA_LICENSE_ENFORCE=True)
class WorkspaceAccessTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.middleware = WorkspaceLicenseMiddleware(lambda request: None)
        self.view = SimpleNamespace(__name__='create_item')

    def test_every_native_write_uses_its_manifest_route_and_only_metadata(self):
        for module_id, (_, manifest) in manifests().items():
            prefix = 'api/guilds/' if module_id == 'servers' else manifest.get('urlPrefix')
            if not prefix: continue
            request = self.factory.post('/' + prefix + 'items/', {'title': 'PRIVATE-CONTENT', 'body': 'SECRET', 'role': 'viewer'}, content_type='application/json')
            with patch('sfera_modules.workspace_access.require', side_effect=CommercialError('subscription_required', 403)) as check:
                response = self.middleware.process_view(request, self.view, (), {})
            self.assertEqual(response.status_code, 403, module_id)
            self.assertEqual(response['Cache-Control'], 'no-store')
            self.assertEqual(check.call_args.args[0], module_id)
            self.assertEqual(check.call_args.kwargs['values'], {'role': 'viewer'})
            self.assertNotIn('PRIVATE-CONTENT', str(check.call_args))

    def test_reads_exports_and_deletions_retain_original_local_acl(self):
        for method in ('get', 'head', 'options', 'delete'):
            request = getattr(self.factory, method)('/api/office/documents/')
            with patch('sfera_modules.workspace_access.require') as check:
                self.assertIsNone(self.middleware.process_view(request, self.view, (), {}))
            check.assert_not_called()

    def test_existing_security_and_hanging_up_do_not_require_a_license(self):
        for path, operation in (('/api/totp/confirm/', 'confirm'), ('/api/totp/disable/', 'disable'), ('/api/conference/conferences/room/end/', 'conference_end')):
            with patch('sfera_modules.workspace_access.require') as check:
                response = self.middleware.process_view(self.factory.post(path), SimpleNamespace(__name__=operation), (), {})
            self.assertIsNone(response)
            check.assert_not_called()

    def test_personal_messages_and_calls_never_contact_company(self):
        for path in ('/api/messages/', '/api/signaling/call/', '/api/server-layout/', '/api/auth/login/', '/api/modules/commercial/activate/'):
            with patch('sfera_modules.workspace_access.require') as check:
                self.assertIsNone(self.middleware.process_view(self.factory.post(path), self.view, (), {}))
            check.assert_not_called()

    def test_unlicensed_realtime_is_closed_before_starting_consumer(self):
        async def scenario():
            sent, started = [], []
            async def receive(): return {'type': 'websocket.connect'}
            async def send(message): sent.append(message)
            async def application(*args): started.append(True)
            with patch('sfera_modules.workspace_sockets.allowed', return_value=False):
                await LicensedSocket(application, 'servers')({}, receive, send)
            self.assertEqual(started, [])
            self.assertEqual(sent, [{'type': 'websocket.close', 'code': 4403}])
        async_to_sync(scenario)()

    def test_readonly_realtime_allows_sync_but_drops_edits_and_cursors(self):
        async def scenario():
            incoming = iter([
                {'type': 'websocket.connect'},
                {'type': 'websocket.receive', 'text': json.dumps({'type': 'hello'})},
                {'type': 'websocket.receive', 'text': json.dumps({'type': 'ops', 'seq': 7})},
                {'type': 'websocket.receive', 'text': json.dumps({'type': 'cursor', 'x': 10})},
                {'type': 'websocket.receive', 'text': json.dumps({'type': 'ping'})},
                {'type': 'websocket.disconnect', 'code': 1000},
            ])
            sent, seen = [], []
            async def receive(): return next(incoming)
            async def send(message): sent.append(message)
            async def application(scope, receive, send):
                while True:
                    message = await receive(); seen.append(message)
                    if message['type'] == 'websocket.disconnect': return
            with patch('sfera_modules.workspace_sockets.allowed', return_value=False):
                await LicensedSocket(application, 'whiteboard')({}, receive, send)
            self.assertEqual(len(seen), 4)
            self.assertEqual(json.loads(sent[0]['text'])['seq'], 7)
            self.assertEqual(json.loads(sent[0]['text'])['error'], 'subscription_required')
        async_to_sync(scenario)()
