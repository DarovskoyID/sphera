def metrics():
    """Traffic with Битрикс24: calls out, events in, failures."""
    from sfera_modules.hooks import approx_count
    from sfera_server.metrics import _cval

    from .models import Connection, Event

    conn = Connection.objects.first()
    connected = 1 if (conn and conn.configured) else 0
    return {
        'tables': {'bitrix_events': approx_count(Event)},
        'prometheus': [
            {'name': 'sfera_bitrix_connected', 'type': 'gauge', 'value': connected,
             'help': '1 when Битрикс24 is connected on this instance'},
            {'name': 'sfera_bitrix_api_requests_total', 'type': 'counter', 'value': _cval('bitrix_api_requests'),
             'help': 'Requests sent to Битрикс24'},
            {'name': 'sfera_bitrix_api_errors_total', 'type': 'counter', 'value': _cval('bitrix_api_errors'),
             'help': 'Requests to Битрикс24 that failed'},
            {'name': 'sfera_bitrix_events_in_total', 'type': 'counter', 'value': _cval('bitrix_events_in'),
             'help': 'Events received from Битрикс24'},
        ],
        'status': {'Битрикс24': {'Подключено': 'да' if connected else 'нет'}},
    }
