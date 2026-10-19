import json
import io
from urllib.error import HTTPError
from email.message import Message
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from django.test import SimpleTestCase, override_settings
from .commercial import CommercialError, call, config, values_checked

@override_settings(SFERA_COMMERCIAL_API_URL='http://127.0.0.1:8020', SFERA_COMMERCIAL_INSTANCE_ID='server-1', SFERA_COMMERCIAL_API_KEY='private-test-key')
class CommercialBridgeTests(SimpleTestCase):
    def test_credentials_remain_on_backend(self):
        headers = Message(); headers['Content-Type'] = 'application/json'
        response = SimpleNamespace(headers=headers, read=lambda limit: b'{"modules": []}')
        context = MagicMock(); context.__enter__.return_value = response
        opener = MagicMock(); opener.open.return_value = context
        with patch('sfera_modules.commercial.build_opener', return_value=opener):
            self.assertEqual(call(SimpleNamespace(id='user-1')), {'modules': []})
        request = opener.open.call_args.args[0]
        self.assertEqual(json.loads(request.data), {'instance_id': 'server-1', 'actor': 'user-1', 'actor_admin': False})
        self.assertEqual(request.get_header('Authorization'), 'Bearer private-test-key')
        self.assertNotIn('private-test-key', request.data.decode())

    def test_unknown_module_and_arbitrary_url_refused(self):
        with self.assertRaises(CommercialError): call(SimpleNamespace(id='u'), module_id='https://evil.test')
        with self.assertRaises(CommercialError): call(SimpleNamespace(id='u'), module_id='amocrm', action_id='../admin')

    def test_nested_values_and_nonfinite_numbers_rejected(self):
        for value in ({'key': {'code': 'x'}}, {'key': float('nan')}, {'__proto__': 'x'}, {'key': 'x' * 4001}):
            with self.assertRaises(CommercialError): values_checked(value)
        self.assertEqual(values_checked({'name': 'Alice', 'active': True}), {'name': 'Alice', 'active': True})

    @override_settings(SFERA_COMMERCIAL_API_URL='http://public.example')
    def test_plaintext_remote_transport_refused(self):
        with self.assertRaises(CommercialError): config()

    @override_settings(SFERA_COMMERCIAL_API_URL='https://good.example/?next=https://evil.test')
    def test_query_string_cannot_select_upstream(self):
        with self.assertRaises(CommercialError): config()

    def test_browser_values_cannot_promote_actor_to_admin(self):
        headers = Message(); headers['Content-Type'] = 'application/json'
        response = SimpleNamespace(headers=headers, read=lambda limit: b'{}')
        context = MagicMock(); context.__enter__.return_value = response
        opener = MagicMock(); opener.open.return_value = context
        with patch('sfera_modules.commercial.build_opener', return_value=opener):
            call(SimpleNamespace(id='member', is_superuser=False), module_id='amocrm', action_id='configure', values={'actor_admin': True})
        payload = json.loads(opener.open.call_args.args[0].data)
        self.assertIs(payload['actor_admin'], False)
        self.assertIs(payload['values']['actor_admin'], True)

    def test_legacy_business_endpoint_is_closed_on_connected_node(self):
        from django.test import RequestFactory
        from .commercial_routes import route
        with patch('importlib.import_module') as legacy_import:
            response = route(RequestFactory().post('/api/amocrm/leads/'), 'amocrm', 'leads/')
        self.assertEqual(response.status_code, 410)
        legacy_import.assert_not_called()

    def test_local_acl_is_checked_before_company_call(self):
        connection = MagicMock()
        connection.allowed_users.exists.return_value = True
        connection.allowed_users.filter.return_value.exists.return_value = False
        model = MagicMock(); model.objects.first.return_value = connection
        with patch('django.apps.apps.get_model', return_value=model), patch('sfera_modules.commercial.build_opener') as opener:
            with self.assertRaises(CommercialError) as denied:
                call(SimpleNamespace(id='member', is_superuser=False), module_id='amocrm')
        self.assertEqual(denied.exception.code, 'module_access_denied')
        opener.assert_not_called()

    def test_upstream_only_exposes_known_error_codes(self):
        for body, expected in [(b'{"error":"action_outcome_unknown"}', 'action_outcome_unknown'), (b'{"error":"private-token-or-internal-error"}', 'commercial_unavailable')]:
            upstream = HTTPError('https://company.test', 409, 'Conflict', {}, io.BytesIO(body))
            with patch('sfera_modules.commercial.build_opener') as factory:
                factory.return_value.open.side_effect = upstream
                with self.assertRaises(CommercialError) as denied:
                    call(SimpleNamespace(id='member', is_superuser=False), module_id='amocrm', action_id='create-lead')
            self.assertEqual(denied.exception.code, expected)
