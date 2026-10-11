def metrics():
    """Traffic with 1С: calls out, events in, failures."""
    from sfera_modules.hooks import approx_count
    from sfera_server.metrics import _cval

    from .models import Connection, Event

    conn = Connection.objects.first()
    connected = 1 if (conn and conn.configured) else 0
    return {
        'tables': {'onec_events': approx_count(Event)},
        'prometheus': [
            {'name': 'sfera_onec_connected', 'type': 'gauge', 'value': connected,
             'help': '1 when 1С is connected on this instance'},
            {'name': 'sfera_onec_api_requests_total', 'type': 'counter', 'value': _cval('onec_api_requests'),
             'help': 'Requests sent to 1С'},
            {'name': 'sfera_onec_api_errors_total', 'type': 'counter', 'value': _cval('onec_api_errors'),
             'help': 'Requests to 1С that failed'},
            {'name': 'sfera_onec_events_in_total', 'type': 'counter', 'value': _cval('onec_events_in'),
             'help': 'Events received from 1С'},
        ],
        'status': {'1С': {'Подключено': 'да' if connected else 'нет'}},
    }
