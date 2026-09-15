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
    from .models import Project, Task, TaskComment

    return {'tables': {
        'planner_projects': Project.objects.count(),
        'planner_tasks': Task.objects.count(),
        'planner_comments': TaskComment.objects.count(),
    }}


def has_data(user):
    from .models import ProjectMember

    return ProjectMember.objects.filter(user=user).exists()
