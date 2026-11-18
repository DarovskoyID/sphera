import json
import secrets
from email.message import Message
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from urllib.error import URLError
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient
from .models import CommercialConnection
from .commercial import activate_key, CommercialError, config


@override_settings(SFERA_COMMERCIAL_API_URL='https://company.example/commercial-api', SFERA_COMMERCIAL_INSTANCE_ID='', SFERA_COMMERCIAL_API_KEY='', SFERA_COMMERCIAL_CREDENTIAL_SOURCE='database')
class NodeActivationTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser(username='license-admin', email='admin@local.test', password='test-password')
        self.member = User.objects.create_user(username='license-member', password='test-password')
        self.raw = 'SFERA-' + secrets.token_urlsafe(32)
        self.token = secrets.token_urlsafe(48)

    def opener(self):
        factory = MagicMock()
        def open_response(request, timeout):
            data = json.loads(request.data)
            headers = Message(); headers['Content-Type'] = 'application/json'
            response = SimpleNamespace(headers=headers, read=lambda limit: json.dumps({'instance_id': data['instance_id'], 'api_key': self.token, 'modules': ['amocrm', 'planner']}).encode())
            context = MagicMock(); context.__enter__.return_value = response
            return context
        factory.open.side_effect = open_response
        return factory

    def test_server_keeps_credentials_encrypted_and_returns_only_entitlements(self):
        with patch('sfera_modules.commercial.build_opener', return_value=self.opener()):
            response = activate_key(self.admin, self.raw)
        self.assertEqual(response, {'activated': True, 'modules': ['amocrm', 'planner']})
        stored = CommercialConnection.objects.get(pk=1)
        self.assertNotIn(self.token, stored.encrypted_api_key)
        self.assertNotIn(self.raw, str(stored.__dict__))
        self.assertEqual(config()[2], self.token)

    def test_member_cannot_send_activation_request(self):
        client = APIClient(headers={'X-Ionik-Client': '1'}); client.force_authenticate(self.member)
        with patch('sfera_modules.commercial.build_opener') as factory:
            response = client.post('/api/modules/commercial/activate/', {'license_key': self.raw}, format='json')
        self.assertEqual(response.status_code, 403)
        factory.assert_not_called()
        self.assertFalse(CommercialConnection.objects.exists())

    def test_activation_http_response_never_contains_server_token(self):
        client = APIClient(headers={'X-Ionik-Client': '1'}); client.force_authenticate(self.admin)
        with patch('sfera_modules.commercial.build_opener', return_value=self.opener()):
            response = client.post('/api/modules/commercial/activate/', {'license_key': self.raw}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Cache-Control'], 'no-store')
        self.assertNotIn(self.token, response.content.decode())
        self.assertNotIn(self.raw, response.content.decode())

    def test_lost_response_preserves_retry_identity(self):
        broken = MagicMock(); broken.open.side_effect = URLError('offline')
        with patch('sfera_modules.commercial.build_opener', return_value=broken):
            with self.assertRaises(CommercialError): activate_key(self.admin, self.raw)
        initial = CommercialConnection.objects.get(pk=1)
        identity = (initial.instance_id, initial.encrypted_claim_nonce)
        with patch('sfera_modules.commercial.build_opener', return_value=self.opener()): activate_key(self.admin, self.raw)
        stored = CommercialConnection.objects.get(pk=1)
        self.assertEqual((stored.instance_id, stored.encrypted_claim_nonce), identity)

    def test_provider_change_does_not_forward_existing_secret(self):
        with patch('sfera_modules.commercial.build_opener', return_value=self.opener()): activate_key(self.admin, self.raw)
        with override_settings(SFERA_COMMERCIAL_API_URL='https://different.example'), patch('sfera_modules.commercial.build_opener') as factory:
            with self.assertRaises(CommercialError): activate_key(self.admin, self.raw)
            with self.assertRaises(CommercialError): config()
        factory.assert_not_called()

    def test_card_selection_is_forwarded_by_node_without_browser_credentials(self):
        opener = self.opener()
        with patch('sfera_modules.commercial.build_opener', return_value=opener):
            response = activate_key(self.admin, self.raw, 'planner')
        self.assertIn('planner', response['modules'])
        request = opener.open.call_args.args[0]
        self.assertEqual(json.loads(request.data)['module_id'], 'planner')

    def test_invalid_module_cannot_be_used_as_activation_target(self):
        with patch('sfera_modules.commercial.build_opener') as factory:
            with self.assertRaises(CommercialError): activate_key(self.admin, self.raw, '../office')
        factory.assert_not_called()
