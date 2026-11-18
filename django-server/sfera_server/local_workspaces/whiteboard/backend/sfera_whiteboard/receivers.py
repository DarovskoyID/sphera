def export(user):
    from .models import BoardMember

    return {'whiteboards': [
        {'id': str(m.board_id), 'name': m.board.name, 'role': m.role, 'doc': m.board.doc}
        for m in BoardMember.objects.filter(user=user).select_related('board').iterator()
    ]}


def metrics():
    """Load of the boards: edits per second and how many boards are being edited."""
    from datetime import timedelta

    from django.utils import timezone
    from sfera_modules.hooks import approx_count
    from sfera_server.metrics import _cval

    from .models import Board, BoardMember

    live = Board.objects.filter(updated_at__gte=timezone.now() - timedelta(minutes=5)).count()
    return {
        'tables': {'whiteboards': approx_count(Board), 'whiteboard_members': approx_count(BoardMember)},
        'prometheus': [
            {'name': 'sfera_whiteboard_ops_total', 'type': 'counter', 'value': _cval('whiteboard_ops'),
             'help': 'Shape operations applied to boards'},
            {'name': 'sfera_whiteboard_op_errors_total', 'type': 'counter', 'value': _cval('whiteboard_op_errors'),
             'help': 'Operations rejected as invalid'},
            {'name': 'sfera_whiteboard_live_boards', 'type': 'gauge', 'value': live,
             'help': 'Boards edited in the last 5 minutes'},
        ],
        'status': {'Доски': {'Редактируются сейчас': live}},
    }


def has_data(user):
    from .models import BoardMember

    return BoardMember.objects.filter(user=user).exists()
