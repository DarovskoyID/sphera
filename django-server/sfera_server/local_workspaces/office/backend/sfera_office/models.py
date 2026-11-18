import uuid

from django.conf import settings
from django.db import models

KIND_DOC, KIND_SHEET, KIND_DECK = 'doc', 'sheet', 'deck'
KINDS = [(KIND_DOC, 'Document'), (KIND_SHEET, 'Spreadsheet'), (KIND_DECK, 'Presentation')]

ROLE_OWNER, ROLE_EDITOR, ROLE_VIEWER = 'owner', 'editor', 'viewer'
ROLES = [(ROLE_OWNER, 'Owner'), (ROLE_EDITOR, 'Editor'), (ROLE_VIEWER, 'Viewer')]

# One document is one JSON row edited under a row lock, so its size is what
# bounds the cost of every edit: keep it small enough to read, patch and write
# back many times per second.
MAX_DOC_BYTES = 3 * 1024 * 1024
MAX_BLOCKS = 5000
MAX_CELLS = 50_000
MAX_SLIDES = 300
MAX_DOCS_PER_USER = 500
MAX_COMMENTS = 2000
# A snapshot every N versions: history without keeping every keystroke.
REVISION_EVERY = 50
REVISIONS_KEPT = 30


def empty_doc(kind=KIND_DOC):
    if kind == KIND_SHEET:
        return {'cells': {}, 'rows': 50, 'cols': 12, 'widths': {}}
    if kind == KIND_DECK:
        return {'slides': {}, 'order': [], 'theme': 'light'}
    return {'blocks': {}, 'order': []}


class Doc(models.Model):
    """A document, a spreadsheet or a deck. Edited with small ops (see ops.py)."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    kind = models.CharField(max_length=6, choices=KINDS, default=KIND_DOC)
    title = models.CharField(max_length=160)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    data = models.JSONField(default=dict)
    version = models.PositiveBigIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']
        indexes = [models.Index(fields=['-updated_at'])]


class DocMember(models.Model):
    doc = models.ForeignKey(Doc, on_delete=models.CASCADE, related_name='members')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='office_memberships')
    role = models.CharField(max_length=10, choices=ROLES, default=ROLE_EDITOR)
    opened_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['doc', 'user'], name='office_uniq_member')]
        indexes = [models.Index(fields=['user', 'role'])]


class DocRevision(models.Model):
    """Snapshot of the whole document, written every REVISION_EVERY versions."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    doc = models.ForeignKey(Doc, on_delete=models.CASCADE, related_name='revisions')
    version = models.PositiveBigIntegerField()
    data = models.JSONField()
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-version']
        constraints = [models.UniqueConstraint(fields=['doc', 'version'], name='office_uniq_revision')]


class DocComment(models.Model):
    """A comment pinned to a block, a cell or a slide."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    doc = models.ForeignKey(Doc, on_delete=models.CASCADE, related_name='comments')
    anchor = models.CharField(max_length=48)
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    text = models.TextField()
    resolved = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['created_at']
        indexes = [models.Index(fields=['doc', 'resolved'])]
