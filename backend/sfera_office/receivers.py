def export(user):
    from .models import DocComment, DocMember

    return {
        'office_documents': [
            {'id': str(m.doc_id), 'kind': m.doc.kind, 'title': m.doc.title, 'role': m.role,
             'updated_at': m.doc.updated_at.isoformat(), 'data': m.doc.data}
            for m in DocMember.objects.filter(user=user).select_related('doc').iterator()
        ],
        'office_comments': [
            {'document': str(c.doc_id), 'anchor': c.anchor, 'text': c.text,
             'resolved': c.resolved, 'created_at': c.created_at.isoformat()}
            for c in DocComment.objects.filter(author=user).iterator()
        ],
    }


def metrics():
    """Load of co-editing: edits per second and how many documents are open."""
    from datetime import timedelta

    from django.db.models import Count
    from django.utils import timezone
    from sfera_modules.hooks import approx_count
    from sfera_server.metrics import _cval

    from .models import Doc, DocComment, DocMember, DocRevision

    live = Doc.objects.filter(updated_at__gte=timezone.now() - timedelta(minutes=5)).count()
    by_kind = {row['kind']: row['n'] for row in Doc.objects.values('kind').annotate(n=Count('id'))}
    return {
        'tables': {
            'office_documents': approx_count(Doc),
            'office_members': approx_count(DocMember),
            'office_revisions': approx_count(DocRevision),
            'office_comments': approx_count(DocComment),
        },
        'prometheus': [
            {'name': 'sfera_office_ops_total', 'type': 'counter', 'value': _cval('office_ops'),
             'help': 'Edits applied to documents, spreadsheets and decks'},
            {'name': 'sfera_office_op_errors_total', 'type': 'counter', 'value': _cval('office_op_errors'),
             'help': 'Edits rejected as invalid or too large'},
            {'name': 'sfera_office_docs_created_total', 'type': 'counter', 'value': _cval('office_docs_created'),
             'help': 'Documents created'},
            {'name': 'sfera_office_revisions_total', 'type': 'counter', 'value': _cval('office_revisions'),
             'help': 'Version snapshots written'},
            {'name': 'sfera_office_comments_total', 'type': 'counter', 'value': _cval('office_comments'),
             'help': 'Comments left in documents'},
            {'name': 'sfera_office_live_docs', 'type': 'gauge', 'value': live,
             'help': 'Documents edited in the last 5 minutes'},
            {'name': 'sfera_office_documents', 'type': 'gauge', 'value': by_kind.get('doc', 0),
             'help': 'Text documents'},
            {'name': 'sfera_office_sheets', 'type': 'gauge', 'value': by_kind.get('sheet', 0),
             'help': 'Spreadsheets'},
            {'name': 'sfera_office_decks', 'type': 'gauge', 'value': by_kind.get('deck', 0),
             'help': 'Presentations'},
        ],
        'status': {'Документы': {
            'Редактируются сейчас': live,
            'Документов / таблиц / презентаций': f"{by_kind.get('doc', 0)} / {by_kind.get('sheet', 0)} / {by_kind.get('deck', 0)}",
        }},
    }


def has_data(user):
    from .models import DocMember

    return DocMember.objects.filter(user=user).exists()
