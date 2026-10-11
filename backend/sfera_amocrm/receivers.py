def metrics():
    """Traffic with amoCRM: calls out, events in, failures."""
    from sfera_modules.hooks import approx_count
    from sfera_server.metrics import _cval

    from .models import Connection, Event

    conn = Connection.objects.first()
    connected = 1 if (conn and conn.configured) else 0
    return {
        'tables': {'amocrm_events': approx_count(Event)},
        'prometheus': [
            {'name': 'sfera_amocrm_connected', 'type': 'gauge', 'value': connected,
             'help': '1 when amoCRM is connected on this instance'},
            {'name': 'sfera_amocrm_api_requests_total', 'type': 'counter', 'value': _cval('amocrm_api_requests'),
             'help': 'Requests sent to amoCRM'},
            {'name': 'sfera_amocrm_api_errors_total', 'type': 'counter', 'value': _cval('amocrm_api_errors'),
             'help': 'Requests to amoCRM that failed'},
            {'name': 'sfera_amocrm_events_in_total', 'type': 'counter', 'value': _cval('amocrm_events_in'),
             'help': 'Events received from amoCRM'},
        ],
        'status': {'amoCRM': {'Подключено': 'да' if connected else 'нет'}},
    }
