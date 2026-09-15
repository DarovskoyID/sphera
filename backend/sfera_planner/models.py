import uuid

from django.conf import settings
from django.db import models

ROLE_OWNER, ROLE_EDITOR, ROLE_VIEWER = 'owner', 'editor', 'viewer'
ROLES = [(ROLE_OWNER, 'Owner'), (ROLE_EDITOR, 'Editor'), (ROLE_VIEWER, 'Viewer')]

RECURRENCE = [('none', 'None'), ('daily', 'Daily'), ('weekdays', 'Weekdays'), ('weekly', 'Weekly'), ('monthly', 'Monthly')]

MAX_PROJECTS_PER_USER = 200
MAX_TASKS_PER_PROJECT = 5000


class Project(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=120)
    color = models.CharField(max_length=16, default='#6366f1')
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['created_at']


class ProjectMember(models.Model):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='members')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='planner_memberships')
    role = models.CharField(max_length=10, choices=ROLES, default=ROLE_EDITOR)
    added_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['project', 'user'], name='planner_uniq_member')]


class Column(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='columns')
    title = models.CharField(max_length=60)
    order = models.FloatField(default=0)
    # Tasks moved here count as completed.
    is_done = models.BooleanField(default=False)

    class Meta:
        ordering = ['order']


class Task(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='tasks')
    column = models.ForeignKey(Column, on_delete=models.CASCADE, related_name='tasks')
    title = models.CharField(max_length=300)
    description = models.TextField(blank=True, default='', max_length=20000)
    # 0 — none, 1 — low, 2 — medium, 3 — high, 4 — urgent.
    priority = models.PositiveSmallIntegerField(default=0)
    start_at = models.DateTimeField(null=True, blank=True)
    due_at = models.DateTimeField(null=True, blank=True, db_index=True)
    all_day = models.BooleanField(default=False)
    # Minutes before due_at to remind assignees; null — no reminder.
    reminder_minutes = models.PositiveIntegerField(null=True, blank=True)
    reminded_at = models.DateTimeField(null=True, blank=True)
    recurrence = models.CharField(max_length=10, choices=RECURRENCE, default='none')
    order = models.FloatField(default=0)
    labels = models.JSONField(default=list, blank=True)
    checklist = models.JSONField(default=list, blank=True)
    assignees = models.ManyToManyField(settings.AUTH_USER_MODEL, related_name='planner_tasks', blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['order', 'created_at']
        indexes = [models.Index(fields=['project', 'column', 'order'])]


class TaskComment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name='comments')
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='+')
    text = models.TextField(max_length=5000)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['created_at']
