import uuid

from django.conf import settings
from django.db import models

ROLE_OWNER, ROLE_EDITOR, ROLE_VIEWER = 'owner', 'editor', 'viewer'
ROLES = [(ROLE_OWNER, 'Owner'), (ROLE_EDITOR, 'Editor'), (ROLE_VIEWER, 'Viewer')]

MAX_SHAPES = 5000
MAX_DOC_BYTES = 4 * 1024 * 1024
MAX_BOARDS_PER_USER = 300


def empty_doc():
    return {'shapes': {}, 'order': []}


class Board(models.Model):
    """A diagram: shapes by id plus their z-order. Edited with small ops (see ops.py)."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=120)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    doc = models.JSONField(default=empty_doc)
    version = models.PositiveBigIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']


class BoardMember(models.Model):
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name='members')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='whiteboard_memberships')
    role = models.CharField(max_length=10, choices=ROLES, default=ROLE_EDITOR)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['board', 'user'], name='whiteboard_uniq_member')]
