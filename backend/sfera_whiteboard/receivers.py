def export(user):
    from .models import BoardMember

    return {'whiteboards': [
        {'id': str(m.board_id), 'name': m.board.name, 'role': m.role, 'doc': m.board.doc}
        for m in BoardMember.objects.filter(user=user).select_related('board').iterator()
    ]}


def metrics():
    from .models import Board

    return {'tables': {'whiteboards': Board.objects.count()}}


def has_data(user):
    from .models import BoardMember

    return BoardMember.objects.filter(user=user).exists()
