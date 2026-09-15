def metrics():
    from .models import Event

    return {'tables': {'onec_events': Event.objects.count()}}
