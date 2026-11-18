"""Task planner API (mounted at /api/planner/)."""
import calendar
import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Max, Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from sfera_messages.services import _author_brief
from sfera_server.metrics import inc as metrics_inc
from sfera_modules.hooks import push_to_user
from sfera_modules.permissions import requires_module

from .models import (
    MAX_PROJECTS_PER_USER, MAX_TASKS_PER_PROJECT, RECURRENCE, ROLE_EDITOR, ROLE_OWNER, ROLE_VIEWER,
    Column, Project, ProjectMember, Task, TaskComment,
)

MODULE = 'planner'
DEFAULT_COLUMNS = [('К выполнению', False), ('В работе', False), ('Готово', True)]
RECURRENCE_IDS = {r for r, _ in RECURRENCE}


def _err(code, status=400, **extra):
    return Response({'error': code, **extra}, status=status)


# ── Serialization ────────────────────────────────────────────────────────────

def _task_data(t):
    return {
        'id': str(t.id),
        'project_id': str(t.project_id),
        'column_id': str(t.column_id),
        'title': t.title,
        'description': t.description,
        'priority': t.priority,
        'start_at': t.start_at.isoformat() if t.start_at else None,
        'due_at': t.due_at.isoformat() if t.due_at else None,
        'all_day': t.all_day,
        'reminder_minutes': t.reminder_minutes,
        'recurrence': t.recurrence,
        'order': t.order,
        'labels': t.labels or [],
        'checklist': t.checklist or [],
        'assignees': [_author_brief(u) for u in t.assignees.all()],
        'created_by': str(t.created_by_id) if t.created_by_id else None,
        'created_at': t.created_at.isoformat(),
        'updated_at': t.updated_at.isoformat(),
        'completed_at': t.completed_at.isoformat() if t.completed_at else None,
        'comments_count': getattr(t, 'comments_count', None),
    }


def _project_brief(p, role):
    return {'id': str(p.id), 'name': p.name, 'color': p.color, 'role': role, 'created_at': p.created_at.isoformat()}


def _project_full(p, role):
    tasks = p.tasks.select_related('column').prefetch_related('assignees')
    return {
        **_project_brief(p, role),
        'columns': [{'id': str(c.id), 'title': c.title, 'order': c.order, 'is_done': c.is_done} for c in p.columns.all()],
        'members': [{**_author_brief(m.user), 'role': m.role} for m in p.members.select_related('user')],
        'tasks': [_task_data(t) for t in tasks],
    }


# ── Access ───────────────────────────────────────────────────────────────────

def _role(user, project_id):
    m = ProjectMember.objects.filter(project_id=project_id, user=user).only('role').first()
    return m.role if m else None


def _project_for(request, project_id, write=False):
    """(project, role) or an error response."""
    role = _role(request.user, project_id)
    if role is None:
        return None, None, _err('not_found', 404)
    if write and role == ROLE_VIEWER:
        return None, None, _err('forbidden', 403)
    return Project.objects.get(id=project_id), role, None


def _notify(project_id, event='planner.changed', **payload):
    """Everyone in the project re-reads it (other tabs and devices included)."""
    user_ids = list(ProjectMember.objects.filter(project_id=project_id).values_list('user_id', flat=True))

    def send():
        for uid in user_ids:
            try:
                push_to_user(uid, event, {'project_id': str(project_id), **payload})
            except Exception:
                pass
    transaction.on_commit(send)


def _parse_dt(value):
    if value in (None, ''):
        return None
    dt = parse_datetime(str(value))
    if dt is None:
        raise ValueError('bad_datetime')
    return dt if timezone.is_aware(dt) else timezone.make_aware(dt)


def _clean_labels(raw):
    out = []
    for lbl in (raw or [])[:20]:
        s = str(lbl).strip()[:32]
        if s and s not in out:
            out.append(s)
    return out


def _clean_checklist(raw):
    out = []
    for item in (raw or [])[:100]:
        if not isinstance(item, dict):
            continue
        text = str(item.get('text', '')).strip()[:300]
        if text:
            out.append({'id': str(item.get('id') or uuid.uuid4().hex[:12])[:32], 'text': text, 'done': bool(item.get('done'))})
    return out


# ── Projects ─────────────────────────────────────────────────────────────────

@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def project_list_create(request):
    if request.method == 'GET':
        members = ProjectMember.objects.filter(user=request.user).select_related('project').order_by('project__created_at')
        return Response([_project_brief(m.project, m.role) for m in members])

    name = str(request.data.get('name', '')).strip()[:120]
    if not name:
        return _err('name_required')
    if ProjectMember.objects.filter(user=request.user, role=ROLE_OWNER).count() >= MAX_PROJECTS_PER_USER:
        return _err('limit', 409)
    with transaction.atomic():
        p = Project.objects.create(name=name, owner=request.user, color=str(request.data.get('color') or '#6366f1')[:16])
        ProjectMember.objects.create(project=p, user=request.user, role=ROLE_OWNER)
        for i, (title, done) in enumerate(DEFAULT_COLUMNS):
            Column.objects.create(project=p, title=title, order=i, is_done=done)
    return Response(_project_full(p, ROLE_OWNER), status=201)


@api_view(['GET', 'PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def project_detail(request, project_id):
    p, role, err = _project_for(request, project_id, write=request.method != 'GET')
    if err:
        return err
    if request.method == 'GET':
        return Response(_project_full(p, role))
    if request.method == 'DELETE':
        if role != ROLE_OWNER:
            return _err('forbidden', 403)
        _notify(p.id, 'planner.removed')
        p.delete()
        return Response(status=204)
    if 'name' in request.data:
        name = str(request.data['name']).strip()[:120]
        if not name:
            return _err('name_required')
        p.name = name
    if 'color' in request.data:
        p.color = str(request.data['color'])[:16]
    p.save()
    _notify(p.id)
    return Response(_project_brief(p, role))


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def member_add(request, project_id):
    p, role, err = _project_for(request, project_id)
    if err:
        return err
    if role != ROLE_OWNER:
        return _err('forbidden', 403)
    new_role = request.data.get('role', ROLE_EDITOR)
    if new_role not in (ROLE_EDITOR, ROLE_VIEWER):
        return _err('bad_role')
    user = get_user_model().objects.filter(id=request.data.get('user_id'), is_active=True).first()
    if not user:
        return _err('user_not_found', 404)
    ProjectMember.objects.update_or_create(project=p, user=user, defaults={'role': new_role})
    _notify(p.id)
    return Response(_project_full(p, role), status=201)


@api_view(['PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def member_detail(request, project_id, user_id):
    p, role, err = _project_for(request, project_id)
    if err:
        return err
    leaving = str(user_id) == str(request.user.id)
    if role != ROLE_OWNER and not (leaving and request.method == 'DELETE'):
        return _err('forbidden', 403)
    m = ProjectMember.objects.filter(project=p, user_id=user_id).first()
    if not m:
        return _err('not_found', 404)
    if m.role == ROLE_OWNER:
        return _err('owner_stays', 409)
    if request.method == 'DELETE':
        _notify(p.id)
        m.delete()
        Task.assignees.through.objects.filter(task__project=p, user_id=user_id).delete()
        return Response(status=204)
    new_role = request.data.get('role')
    if new_role not in (ROLE_EDITOR, ROLE_VIEWER):
        return _err('bad_role')
    m.role = new_role
    m.save(update_fields=['role'])
    _notify(p.id)
    return Response(_project_full(p, role))


# ── Columns ──────────────────────────────────────────────────────────────────

@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def column_create(request, project_id):
    p, _, err = _project_for(request, project_id, write=True)
    if err:
        return err
    title = str(request.data.get('title', '')).strip()[:60]
    if not title:
        return _err('title_required')
    if p.columns.count() >= 30:
        return _err('limit', 409)
    top = p.columns.aggregate(m=Max('order'))['m']
    c = Column.objects.create(project=p, title=title, order=(top or 0) + 1, is_done=bool(request.data.get('is_done')))
    _notify(p.id)
    return Response({'id': str(c.id), 'title': c.title, 'order': c.order, 'is_done': c.is_done}, status=201)


@api_view(['PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def column_detail(request, column_id):
    c = Column.objects.filter(id=column_id).first()
    if not c:
        return _err('not_found', 404)
    _, _, err = _project_for(request, c.project_id, write=True)
    if err:
        return err
    if request.method == 'DELETE':
        rest = Column.objects.filter(project_id=c.project_id).exclude(id=c.id).first()
        if not rest:
            return _err('last_column', 409)
        with transaction.atomic():
            Task.objects.filter(column=c).update(column=rest)
            c.delete()
        _notify(c.project_id)
        return Response(status=204)
    if 'title' in request.data:
        title = str(request.data['title']).strip()[:60]
        if title:
            c.title = title
    if 'order' in request.data:
        c.order = float(request.data['order'])
    if 'is_done' in request.data:
        c.is_done = bool(request.data['is_done'])
    c.save()
    _notify(c.project_id)
    return Response({'id': str(c.id), 'title': c.title, 'order': c.order, 'is_done': c.is_done})


# ── Tasks ────────────────────────────────────────────────────────────────────

def _apply_task_fields(t, data, project):
    """Validate and set editable fields; returns an error code or None."""
    if 'title' in data:
        title = str(data['title']).strip()[:300]
        if not title:
            return 'title_required'
        t.title = title
    if 'description' in data:
        t.description = str(data['description'] or '')[:20000]
    if 'priority' in data:
        try:
            t.priority = max(0, min(4, int(data['priority'])))
        except (TypeError, ValueError):
            return 'bad_priority'
    for field in ('start_at', 'due_at'):
        if field in data:
            try:
                setattr(t, field, _parse_dt(data[field]))
            except ValueError:
                return 'bad_datetime'
            if field == 'due_at':
                t.reminded_at = None
    if 'all_day' in data:
        t.all_day = bool(data['all_day'])
    if 'reminder_minutes' in data:
        v = data['reminder_minutes']
        t.reminder_minutes = None if v in (None, '') else max(0, min(60 * 24 * 30, int(v)))
        t.reminded_at = None
    if 'recurrence' in data:
        if data['recurrence'] not in RECURRENCE_IDS:
            return 'bad_recurrence'
        t.recurrence = data['recurrence']
    if 'labels' in data:
        t.labels = _clean_labels(data['labels'])
    if 'checklist' in data:
        t.checklist = _clean_checklist(data['checklist'])
    if 'order' in data:
        t.order = float(data['order'])
    if 'column_id' in data:
        col = Column.objects.filter(id=data['column_id'], project=project).first()
        if not col:
            return 'bad_column'
        t.column = col
    elif 'done' in data and bool(data['done']) != t.column.is_done:
        # Checkbox in lists: to the first "done" column, or back to the first open one.
        col = Column.objects.filter(project=project, is_done=bool(data['done'])).first()
        if not col:
            return 'no_done_column' if data['done'] else 'no_open_column'
        t.column = col
    return None


def _set_assignees(t, ids):
    allowed = set(ProjectMember.objects.filter(project_id=t.project_id, user_id__in=list(ids or [])[:50])
                  .values_list('user_id', flat=True))
    t.assignees.set(list(allowed))


def _next_due(due, rule):
    if rule == 'daily':
        return due + timedelta(days=1)
    if rule == 'weekdays':
        nxt = due + timedelta(days=1)
        while nxt.weekday() >= 5:
            nxt += timedelta(days=1)
        return nxt
    if rule == 'weekly':
        return due + timedelta(weeks=1)
    if rule == 'monthly':
        month = due.month % 12 + 1
        year = due.year + (due.month // 12)
        return due.replace(year=year, month=month, day=min(due.day, calendar.monthrange(year, month)[1]))
    return None


def _spawn_next(t):
    """A recurring task that got done comes back with the next due date."""
    if t.recurrence == 'none' or not t.due_at:
        return None
    first = Column.objects.filter(project_id=t.project_id, is_done=False).first()
    if not first:
        return None
    nxt = Task.objects.create(
        project_id=t.project_id, column=first, title=t.title, description=t.description, priority=t.priority,
        due_at=_next_due(t.due_at, t.recurrence), all_day=t.all_day, reminder_minutes=t.reminder_minutes,
        recurrence=t.recurrence, labels=t.labels,
        checklist=[{**i, 'done': False} for i in (t.checklist or [])], created_by=t.created_by,
        order=(Task.objects.filter(column=first).aggregate(m=Max('order'))['m'] or 0) + 1,
    )
    nxt.assignees.set(t.assignees.all())
    t.recurrence = 'none'  # the chain continues from the new task
    t.save(update_fields=['recurrence'])
    return nxt


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def task_create(request, project_id):
    p, _, err = _project_for(request, project_id, write=True)
    if err:
        return err
    if p.tasks.count() >= MAX_TASKS_PER_PROJECT:
        return _err('limit', 409)
    data = request.data
    col = Column.objects.filter(id=data.get('column_id'), project=p).first() or p.columns.first()
    t = Task(project=p, column=col, created_by=request.user,
             order=(Task.objects.filter(column=col).aggregate(m=Max('order'))['m'] or 0) + 1)
    code = _apply_task_fields(t, {**data, 'title': data.get('title', '')}, p)
    if code:
        return _err(code)
    with transaction.atomic():
        if t.column.is_done:
            t.completed_at = timezone.now()
        t.save()
        if 'assignee_ids' in data:
            _set_assignees(t, data['assignee_ids'])
    _notify(p.id)
    metrics_inc('planner_tasks_created')
    return Response(_task_data(t), status=201)


@api_view(['GET', 'PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def task_detail(request, task_id):
    t = Task.objects.select_related('column', 'project').filter(id=task_id).first()
    if not t:
        return _err('not_found', 404)
    _, _, err = _project_for(request, t.project_id, write=request.method != 'GET')
    if err:
        return err
    if request.method == 'GET':
        return Response(_task_data(t))
    if request.method == 'DELETE':
        t.delete()
        _notify(t.project_id)
        return Response(status=204)
    was_done = t.column.is_done
    code = _apply_task_fields(t, request.data, t.project)
    if code:
        return _err(code)
    spawned = None
    with transaction.atomic():
        if t.column.is_done and not was_done:
            t.completed_at = timezone.now()
            spawned = _spawn_next(t)
        elif not t.column.is_done:
            t.completed_at = None
        t.save()
        if 'assignee_ids' in request.data:
            _set_assignees(t, request.data['assignee_ids'])
    _notify(t.project_id)
    out = _task_data(t)
    if spawned:
        out['next'] = _task_data(spawned)
    return Response(out)


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def task_comments(request, task_id):
    t = Task.objects.filter(id=task_id).first()
    if not t:
        return _err('not_found', 404)
    _, _, err = _project_for(request, t.project_id)
    if err:
        return err
    if request.method == 'POST':
        text = str(request.data.get('text', '')).strip()[:5000]
        if not text:
            return _err('text_required')
        TaskComment.objects.create(task=t, author=request.user, text=text)
        _notify(t.project_id, 'planner.comment', task_id=str(t.id))
    return Response([
        {'id': str(c.id), 'text': c.text, 'author': _author_brief(c.author), 'created_at': c.created_at.isoformat()}
        for c in t.comments.select_related('author')
    ])


# ── Across projects ──────────────────────────────────────────────────────────

@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def my_tasks(request):
    """Tasks assigned to me (or all tasks of my projects with ?scope=all), optionally in a due range."""
    project_ids = ProjectMember.objects.filter(user=request.user).values_list('project_id', flat=True)
    qs = Task.objects.filter(project_id__in=project_ids)
    if request.query_params.get('scope') != 'all':
        qs = qs.filter(assignees=request.user)
    try:
        start = _parse_dt(request.query_params.get('from'))
        end = _parse_dt(request.query_params.get('to'))
    except ValueError:
        return _err('bad_datetime')
    if start:
        qs = qs.filter(Q(due_at__gte=start) | Q(start_at__gte=start))
    if end:
        qs = qs.filter(Q(due_at__lt=end) | Q(start_at__lt=end))
    if request.query_params.get('open') == '1':
        qs = qs.filter(column__is_done=False)
    qs = qs.distinct().select_related('column').prefetch_related('assignees').order_by('due_at', 'order')[:1000]
    return Response([_task_data(t) for t in qs])


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def reminders_due(request):
    """Reminders that came due for my open tasks; each is returned once."""
    now = timezone.now()
    project_ids = ProjectMember.objects.filter(user=request.user).values_list('project_id', flat=True)
    candidates = (Task.objects.filter(project_id__in=project_ids, assignees=request.user, reminder_minutes__isnull=False,
                                      due_at__isnull=False, reminded_at__isnull=True, column__is_done=False,
                                      due_at__lte=now + timedelta(days=31))
                  .select_related('project').prefetch_related('assignees').distinct())
    due = [t for t in candidates if t.due_at - timedelta(minutes=t.reminder_minutes) <= now]
    Task.objects.filter(id__in=[t.id for t in due]).update(reminded_at=now)
    if due:
        metrics_inc('planner_reminders_sent', len(due))
    return Response([{**_task_data(t), 'project_name': t.project.name} for t in due])


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def user_search(request):
    q = str(request.query_params.get('q', '')).strip()[:64]
    if len(q) < 1:
        return Response([])
    users = (get_user_model().objects.filter(is_active=True)
             .filter(Q(username__icontains=q) | Q(nickname__icontains=q))
             .exclude(account_type='bot').order_by('username')[:20])
    return Response([_author_brief(u) for u in users])
