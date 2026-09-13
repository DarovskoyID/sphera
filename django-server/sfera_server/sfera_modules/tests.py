import json
import tempfile
from pathlib import Path
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.db import IntegrityError, transaction
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from . import loader
from .models import InstanceModule
from .permissions import has_module


def _write_modules(root: Path, specs: dict):
    for mid, extra in specs.items():
        d = root / mid
        d.mkdir()
        (d / 'module.json').write_text(json.dumps({'id': mid, 'version': '1.0.0', **extra}), encoding='utf-8')


class ModuleRegistryTests(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        _write_modules(root, {
            'servers': {},
            'channels': {},
            'family': {'deps': ['servers']},
            'orphan': {'deps': ['missing']},
            'future': {'sdkVersion': 99},
        })
        self.patches = [
            mock.patch.object(loader, 'MODULES_DIR', root),
            mock.patch.object(loader, '_cache', None),
        ]
        for p in self.patches:
            p.start()
        User = get_user_model()
        self.user = User.objects.create_superuser(username='root', email='root@x.ru', password='pass12345')
        self.member = User.objects.create_user(username='u1', email='u1@x.ru', password='pass12345')
        self.client = APIClient(headers={'X-Ionik-Client': '1'})
        self.client.force_authenticate(self.user)
        self.member_client = APIClient(headers={'X-Ionik-Client': '1'})
        self.member_client.force_authenticate(self.member)

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_discover_skips_missing_deps_and_foreign_sdk(self):
        self.assertEqual(set(loader.discover()), {'servers', 'channels', 'family'})

    @override_settings(SFERA_MODULES_ENFORCE=True)
    def test_install_pulls_deps_and_uninstall_is_guarded(self):
        r = self.client.post('/api/modules/family/install/')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(set(r.data['installed']), {'family', 'servers'})

        r = self.client.delete('/api/modules/servers/install/')
        self.assertEqual(r.status_code, 409)

        self.assertEqual(self.client.delete('/api/modules/family/install/').status_code, 200)
        self.assertEqual(self.client.delete('/api/modules/servers/install/').status_code, 200)
        self.assertFalse(InstanceModule.objects.exists())

    @override_settings(SFERA_MODULES_ENFORCE=True)
    def test_list_and_gate(self):
        self.assertFalse(has_module(self.member, 'channels'))
        self.client.post('/api/modules/channels/install/')
        # Installed by the superuser for the whole instance.
        self.assertTrue(has_module(self.member, 'channels'))
        data = self.member_client.get('/api/modules/').data
        self.assertFalse(data['can_manage'])
        mods = {m['id']: m['installed'] for m in data['modules']}
        self.assertEqual(mods, {'servers': False, 'channels': True, 'family': False})
        self.assertTrue(self.client.get('/api/modules/').data['can_manage'])

    @override_settings(SFERA_MODULES_ENFORCE=True)
    def test_only_superuser_manages_modules(self):
        self.assertEqual(self.member_client.post('/api/modules/servers/install/').status_code, 403)
        self.client.post('/api/modules/servers/install/')
        self.assertEqual(self.member_client.delete('/api/modules/servers/install/').status_code, 403)
        self.assertTrue(InstanceModule.objects.filter(module_id='servers').exists())

    def test_unknown_module(self):
        self.assertEqual(self.client.post('/api/modules/nope/install/').status_code, 404)

    def test_not_enforced_means_everything_installed(self):
        self.assertTrue(has_module(self.user, 'servers'))


class SuperuserTests(TestCase):
    def test_only_one_superuser(self):
        User = get_user_model()
        User.objects.create_superuser(username='root', email='r@x.ru', password='pass12345')
        with self.assertRaises(IntegrityError), transaction.atomic():
            User.objects.create_superuser(username='root2', email='r2@x.ru', password='pass12345')

    def test_ensure_superuser_from_env_is_idempotent(self):
        User = get_user_model()
        env = {'SFERA_SUPERUSER_USERNAME': 'boss', 'SFERA_SUPERUSER_PASSWORD': 'Very-Strong-Pass-42'}
        with mock.patch.dict('os.environ', env):
            call_command('ensure_superuser', '--no-input')
            call_command('ensure_superuser', '--no-input', '--username', 'other', '--password', 'Very-Strong-Pass-43')
        self.assertEqual(list(User.objects.filter(is_superuser=True).values_list('username', flat=True)), ['boss'])
        self.assertTrue(User.objects.get(username='boss').check_password('Very-Strong-Pass-42'))

    def test_ensure_superuser_without_credentials_does_nothing(self):
        with mock.patch.dict('os.environ', {}, clear=False):
            call_command('ensure_superuser', '--no-input')
        self.assertFalse(get_user_model().objects.filter(is_superuser=True).exists())
