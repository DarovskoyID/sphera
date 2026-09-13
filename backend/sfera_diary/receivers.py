def export(user):
    from .models import DiaryEntry

    rows = []
    for e in DiaryEntry.objects.filter(diary__owner=user).select_related('diary').order_by('created_at').iterator():
        try:
            content = e.content
        except Exception:
            content = None
        rows.append({
            'id': str(e.id),
            'diary': e.diary.name,
            'content': content,
            'tags': e.tags or [],
            'type': e.message_type,
            'created_at': e.created_at.isoformat(),
        })
    return {'diary_entries': rows}


def metrics():
    from .models import Diary, DiaryAttachment, DiaryEntry

    return {'tables': {
        'diaries': Diary.objects.count(),
        'diary_entries': DiaryEntry.objects.count(),
        'attachments': DiaryAttachment.objects.count(),
    }}


def has_data(user):
    from .models import Diary

    return Diary.objects.filter(owner=user).exists()
