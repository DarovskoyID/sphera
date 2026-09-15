def metrics():
    from .models import Event

    return {'tables': {'amocrm_events': Event.objects.count()}}
