def export(user):
    from .models import ProjectMember, Task

    project_ids = ProjectMember.objects.filter(user=user).values_list('project_id', flat=True)
    return {'planner_tasks': [
        {
            'id': str(t.id),
            'project': t.project.name,
            'column': t.column.title,
            'title': t.title,
            'description': t.description,
            'due_at': t.due_at.isoformat() if t.due_at else None,
            'completed_at': t.completed_at.isoformat() if t.completed_at else None,
            'checklist': t.checklist,
            'labels': t.labels,
        }
        for t in Task.objects.filter(project_id__in=project_ids).select_related('project', 'column').iterator()
    ]}


def metrics():
    """Dashboard numbers. Row counts are estimated on large tables and the whole
    hook is cached by the core, so a scrape never scans the task table."""
    from datetime import timedelta

    from django.utils import timezone
    from sfera_modules.hooks import approx_count
    from sfera_server.metrics import _cval

    from .models import Project, Task, TaskComment

    due_soon = Task.objects.filter(
        column__is_done=False, due_at__isnull=False,
        due_at__lt=timezone.now() + timedelta(days=1),
    ).count()
    return {
        'tables': {
            'planner_projects': approx_count(Project),
            'planner_tasks': approx_count(Task),
            'planner_comments': approx_count(TaskComment),
        },
        'prometheus': [
            {'name': 'sfera_planner_tasks_created_total', 'type': 'counter', 'value': _cval('planner_tasks_created'),
             'help': 'Tasks created in the planner'},
            {'name': 'sfera_planner_reminders_sent_total', 'type': 'counter', 'value': _cval('planner_reminders_sent'),
             'help': 'Task reminders delivered'},
            {'name': 'sfera_planner_tasks_due_soon', 'type': 'gauge', 'value': due_soon,
             'help': 'Open tasks due within a day'},
        ],
        'status': {'Планировщик': {'Задач к сроку (24 ч)': due_soon}},
    }


def has_data(user):
    from .models import ProjectMember

    return ProjectMember.objects.filter(user=user).exists()
