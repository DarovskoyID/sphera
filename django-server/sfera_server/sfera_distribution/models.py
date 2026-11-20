from django.conf import settings
from django.db import models


class ApplicationReplica(models.Model):
    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    network = models.CharField(max_length=64)
    genesis = models.CharField(max_length=64)
    height = models.PositiveBigIntegerField(default=0)
    snapshot_digest = models.CharField(max_length=64)


class AccountProjection(models.Model):
    owner = models.CharField(max_length=64, primary_key=True)
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    version = models.PositiveIntegerField()
    digest = models.CharField(max_length=64)


class DialogProjection(models.Model):
    identity = models.CharField(max_length=64, primary_key=True)
    conversation = models.OneToOneField('sfera_messages.Conversation', on_delete=models.PROTECT)
    digest = models.CharField(max_length=64)
