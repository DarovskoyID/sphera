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
            'multiserver': {'preAuth': True},
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
        self.assertEqual(set(loader.discover()), {'servers', 'channels', 'family', 'multiserver'})

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
        self.assertEqual(mods, {'servers': False, 'channels': True, 'family': False, 'multiserver': False})
        self.assertTrue(self.client.get('/api/modules/').data['can_manage'])

    @override_settings(SFERA_MODULES_ENFORCE=True)
    def test_public_modules_for_sign_in_screen(self):
        anon = APIClient(headers={'X-Ionik-Client': '1'})
        self.assertEqual(anon.get('/api/modules/public/').data['modules'], [])
        self.client.post('/api/modules/multiserver/install/')
        self.client.post('/api/modules/servers/install/')
        ids = [m['id'] for m in anon.get('/api/modules/public/').data['modules']]
        self.assertEqual(ids, ['multiserver'])

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


class RemoteCatalogTests(TestCase):
    """Modules listed from module/<id> branches and installed from the repository."""

    def setUp(self):
        from . import remote

        self.remote = remote
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        _write_modules(self.root, {'diary': {'backendApp': None}})
        (self.root / 'diary' / 'frontend').mkdir()
        (self.root / 'diary' / 'frontend' / 'index.tsx').write_text('export default {}', encoding='utf-8')
        self.repo = {
            'diary': {'ref': 'a' * 40, 'manifest': {'id': 'diary', 'version': '1.1.0'}},
            'planner': {'ref': 'b' * 40, 'manifest': {'id': 'planner', 'version': '1.0.0', 'name': {'ru': 'Планировщик'}, 'deps': [], 'backendApp': 'sfera_planner'}},
        }
        for p in (
            mock.patch.object(loader, 'MODULES_DIR', self.root),
            mock.patch.object(loader, '_cache', None),
            mock.patch.object(remote, 'catalog', return_value=(self.repo, None)),
            mock.patch.object(remote, 'disk_ref', side_effect=lambda mid: ('c' * 40) if (self.root / mid / 'module.json').exists() else None),
            mock.patch.object(remote, '_loaded_refs', {}),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.tmp.cleanup)
        User = get_user_model()
        self.admin = User.objects.create_superuser(username='root', email='root@x.ru', password='pass12345')
        self.member = User.objects.create_user(username='u1', email='u1@x.ru', password='pass12345')
        self.client = APIClient(headers={'X-Ionik-Client': '1'})
        self.client.force_authenticate(self.admin)

    @override_settings(SFERA_MODULES_ENFORCE=True)
    def test_catalog_shows_repository_versions_and_updates(self):
        data = self.client.get('/api/modules/').data
        mods = {m['id']: m for m in data['modules']}
        self.assertEqual(set(mods), {'diary', 'planner'})
        self.assertTrue(mods['diary']['deployed'])
        self.assertEqual(mods['diary']['latestVersion'], '1.1.0')
        self.assertTrue(mods['diary']['updateAvailable'])
        self.assertTrue(mods['diary']['bundle'].startswith('api/modules/diary/bundle.js?v='))
        self.assertFalse(mods['planner']['deployed'])
        self.assertEqual(mods['planner']['name'], {'ru': 'Планировщик'})
        # Members only see what is on the server.
        member = APIClient(headers={'X-Ionik-Client': '1'})
        member.force_authenticate(self.member)
        self.assertEqual([m['id'] for m in member.get('/api/modules/').data['modules']], ['diary'])

    @override_settings(SFERA_MODULES_ENFORCE=True)
    def test_install_from_repository_starts_a_job(self):
        with mock.patch.object(self.remote.threading, 'Thread') as thread:
            r = self.client.post('/api/modules/planner/install/')
        self.assertEqual(r.status_code, 202)
        self.assertEqual(r.data['jobs'], ['planner'])
        thread.return_value.start.assert_called_once()
        self.assertTrue(InstanceModule.objects.filter(module_id='planner').exists())
        planner = next(m for m in self.client.get('/api/modules/').data['modules'] if m['id'] == 'planner')
        self.assertEqual(planner['pending'], 'installing')
        # Already on the server at the wanted code: installed at once, no job.
        r = self.client.post('/api/modules/diary/install/')
        self.assertEqual((r.status_code, r.data['jobs']), (200, []))

    def test_restart_job_ends_when_the_new_code_is_loaded(self):
        (self.root / '.jobs').mkdir()
        (self.root / '.jobs' / 'diary.json').write_text(json.dumps({'status': 'restarting', 'ref': 'c' * 40}), encoding='utf-8')
        self.assertIsNone(self.remote.job('diary'))
        self.assertFalse((self.root / '.jobs' / 'diary.json').exists())

    def test_unknown_or_malformed_module(self):
        self.assertEqual(self.client.post('/api/modules/nope/install/').status_code, 404)
        self.assertEqual(self.client.post('/api/modules/..%2Fetc/install/').status_code, 404)
        self.assertEqual(APIClient().get('/api/modules/nope/bundle.js').status_code, 404)

    def test_bundle_is_served_without_the_app_header(self):
        built = self.root / '.bundles' / 'diary' / 'x.js'
        built.parent.mkdir(parents=True)
        built.write_text('export default 1', encoding='utf-8')
        with mock.patch.object(self.remote, 'build_bundle', return_value=built):
            r = APIClient().get('/api/modules/diary/bundle.js?v=1')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r['Content-Type'], 'text/javascript; charset=utf-8')
        self.assertIn('immutable', r['Cache-Control'])
        r.close()  # releases the file (Windows keeps it locked)
