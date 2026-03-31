from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    avatar = models.URLField(blank=True, default='')
    bio = models.CharField(max_length=200, blank=True, default='')
    status = models.CharField(
        max_length=10,
        choices=[('online', 'Online'), ('idle', 'Idle'), ('dnd', 'DND'), ('offline', 'Offline')],
        default='offline',
    )

    def __str__(self):
        return self.username
