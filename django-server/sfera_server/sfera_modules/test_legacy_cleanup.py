import importlib
from django.apps import apps
from django.db import connection
from django.test import TestCase
from django.contrib.auth import get_user_model
from types import SimpleNamespace
from .models import InstanceModule, UserModule


class LegacyInstallCleanupTests(TestCase):
    def test_only_old_install_flags_are_deleted(self):
        user = get_user_model().objects.create_user(username='legacy-owner')
        InstanceModule.objects.create(module_id='office', installed_by=user)
        InstanceModule.objects.create(module_id='other-extension', installed_by=user)
        UserModule.objects.create(user=user, module_id='legal')
        migration = importlib.import_module('sfera_modules.migrations.0004_clear_legacy_installs')
        migration.clear_legacy_flags(apps, SimpleNamespace(connection=connection))
        self.assertFalse(InstanceModule.objects.filter(module_id='office').exists())
        self.assertFalse(UserModule.objects.filter(module_id='legal').exists())
        self.assertTrue(InstanceModule.objects.filter(module_id='other-extension').exists())
        self.assertTrue(get_user_model().objects.filter(pk=user.pk).exists())
        migration.clear_legacy_flags(apps, SimpleNamespace(connection=connection))
