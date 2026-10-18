import json
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
        self.assertEqual(json.loads(request.data), {'instance_id': 'server-1', 'actor': 'user-1'})
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
