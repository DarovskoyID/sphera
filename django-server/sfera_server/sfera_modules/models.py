from django.conf import settings
from django.db import models


class InstanceModule(models.Model):
    """A module installed on this instance by the superuser; every user gets it."""
    module_id = models.CharField(max_length=64, unique=True)
    installed_at = models.DateTimeField(auto_now_add=True)
    installed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL)

    def __str__(self):
        return self.module_id


class UserModule(models.Model):
    """Legacy per-user installs (before modules became instance-wide).

    Kept because module data migrations still write it; sfera_modules 0002 turns
    these rows into InstanceModule. Not read at runtime.
    """
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='modules')
    module_id = models.CharField(max_length=64)
    installed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['user', 'module_id'], name='uniq_user_module'),
        ]
        indexes = [models.Index(fields=['module_id'])]

    def __str__(self):
        return f'{self.user_id}:{self.module_id}'
