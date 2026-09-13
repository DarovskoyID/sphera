from django.conf import settings
from django.db import models


class UserModule(models.Model):
    """A module the user installed from «Исследовать сферу».

    Uninstalling deletes this row only; module data stays and reappears on reinstall.
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
