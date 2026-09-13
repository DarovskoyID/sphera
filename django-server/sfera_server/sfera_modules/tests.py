import json
import tempfile
from pathlib import Path
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from . import loader
from .models import UserModule
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
        self.user = get_user_model().objects.create_user(username='u1', email='u1@x.ru', password='pass12345')
        self.client = APIClient(headers={'X-Ionik-Client': '1'})
        self.client.force_authenticate(self.user)

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
        self.assertFalse(UserModule.objects.filter(user=self.user).exists())

    @override_settings(SFERA_MODULES_ENFORCE=True)
    def test_list_and_gate(self):
        self.assertFalse(has_module(self.user, 'channels'))
        self.client.post('/api/modules/channels/install/')
        self.assertTrue(has_module(self.user, 'channels'))
        mods = {m['id']: m['installed'] for m in self.client.get('/api/modules/').data['modules']}
        self.assertEqual(mods, {'servers': False, 'channels': True, 'family': False})

    def test_unknown_module(self):
        self.assertEqual(self.client.post('/api/modules/nope/install/').status_code, 404)

    def test_not_enforced_means_everything_installed(self):
        self.assertTrue(has_module(self.user, 'servers'))
