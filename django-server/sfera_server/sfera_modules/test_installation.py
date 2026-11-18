from unittest.mock import patch
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient
from .models import DisabledCommercialModule
from .commercial import CommercialError, MODULE_IDS
from .workspace_access import require
from .workspace_sockets import allowed
from sfera_office.models import Doc


class CommercialInstallationTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser(username='install-admin', email='admin@local.test')
        self.member = User.objects.create_user(username='install-member')
        self.client = APIClient(headers={'X-Ionik-Client': '1'})
        self.client.force_authenticate(self.admin)
        self.catalog = {'instance_id': 'node', 'modules': [{'id': 'office', 'available': True, 'subscription': {'status': 'active'}}]}

    def endpoint(self, module='office'):
        return f'/api/modules/commercial/{module}/installation/'

    def test_removing_every_module_is_idempotent_local_and_keeps_content(self):
        doc = Doc.objects.create(owner=self.admin, title='Preserve me', data={'blocks': {'private': 'content'}})
        with patch('sfera_modules.commercial.call') as upstream:
            for module in MODULE_IDS:
                for _ in range(2):
                    response = self.client.delete(self.endpoint(module))
                    self.assertEqual(response.status_code, 200)
                    self.assertFalse(response.json()['installed'])
                    self.assertEqual(response['Cache-Control'], 'no-store')
            upstream.assert_not_called()
        self.assertEqual(DisabledCommercialModule.objects.count(), 15)
        doc.refresh_from_db()
        self.assertEqual(doc.data, {'blocks': {'private': 'content'}})

    def test_member_cannot_remove_or_reinstall(self):
        self.client.force_authenticate(self.member)
        with patch('sfera_modules.commercial.call') as upstream:
            self.assertEqual(self.client.delete(self.endpoint()).status_code, 403)
            self.assertEqual(self.client.put(self.endpoint()).status_code, 403)
        upstream.assert_not_called()
        self.assertFalse(DisabledCommercialModule.objects.exists())

    def test_reinstallation_reuses_valid_subscription_and_changes_only_selected_module(self):
        DisabledCommercialModule.objects.create(module_id='office', disabled_by=self.admin)
        DisabledCommercialModule.objects.create(module_id='whiteboard', disabled_by=self.admin)
        with patch('sfera_modules.commercial.call', return_value=self.catalog):
            response = self.client.put(self.endpoint())
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['installed'])
        self.assertFalse(DisabledCommercialModule.objects.filter(module_id='office').exists())
        self.assertTrue(DisabledCommercialModule.objects.filter(module_id='whiteboard').exists())

    def test_expired_license_does_not_reinstall(self):
        DisabledCommercialModule.objects.create(module_id='office', disabled_by=self.admin)
        self.catalog['modules'][0].update(available=False, subscription={'status': 'expired'})
        with patch('sfera_modules.commercial.call', return_value=self.catalog):
            response = self.client.put(self.endpoint())
        self.assertEqual(response.status_code, 403)
        self.assertTrue(DisabledCommercialModule.objects.filter(module_id='office').exists())

    def test_catalog_keeps_subscription_separate_from_local_installation(self):
        DisabledCommercialModule.objects.create(module_id='office', disabled_by=self.admin)
        with patch('sfera_modules.commercial.call', return_value=self.catalog):
            response = self.client.get('/api/modules/commercial/')
        row = response.json()['modules'][0]
        self.assertTrue(row['available'])
        self.assertFalse(row['installed'])
        self.assertEqual(row['subscription']['status'], 'active')

    @override_settings(SFERA_LICENSE_ENFORCE=True)
    def test_removed_module_cannot_write_or_reuse_realtime_cache(self):
        DisabledCommercialModule.objects.create(module_id='office', disabled_by=self.admin)
        with patch('sfera_modules.workspace_access.call') as upstream:
            with self.assertRaises(CommercialError) as error: require('office', 'commit_ops')
        self.assertEqual(error.exception.code, 'module_not_installed')
        upstream.assert_not_called()
        with patch('sfera_modules.workspace_sockets.config') as config:
            self.assertFalse(allowed('office'))
        config.assert_not_called()

    def test_unknown_module_cannot_be_removed(self):
        self.assertEqual(self.client.delete(self.endpoint('made-up')).status_code, 404)
        self.assertFalse(DisabledCommercialModule.objects.exists())
