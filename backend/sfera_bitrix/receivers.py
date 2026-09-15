def metrics():
    from .models import Event

    return {'tables': {'bitrix_events': Event.objects.count()}}
