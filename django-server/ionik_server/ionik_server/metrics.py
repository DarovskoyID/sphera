"""
Prometheus metrics + status page.

Status page: /status-YYYY-MM-DD/  (current date acts as a simple access token)
Prometheus:  /metrics/
"""
import time
import os
import platform
import psutil
from datetime import date
from functools import wraps

from django.http import JsonResponse, HttpResponse
from django.db import connection
from django.conf import settings

# ── In-process counters (atomic via GIL) ─────────────────────────────────────

_counters = {
    'ws_connections_total': 0,
    'ws_messages_received': 0,
    'ws_messages_sent': 0,
    'http_requests_total': 0,
    'http_errors_5xx': 0,
    'startup_time': time.time(),
}

_histograms = {
    'http_request_duration_seconds': [],
}

MAX_HISTOGRAM_SAMPLES = 5000


def inc(name, amount=1):
    _counters[name] = _counters.get(name, 0) + amount


def observe(name, value):
    hist = _histograms.setdefault(name, [])
    hist.append(value)
    if len(hist) > MAX_HISTOGRAM_SAMPLES:
        hist[:] = hist[-MAX_HISTOGRAM_SAMPLES:]


# ── Middleware ────────────────────────────────────────────────────────────────

class MetricsMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        start = time.monotonic()
        response = self.get_response(request)
        duration = time.monotonic() - start

        inc('http_requests_total')
        observe('http_request_duration_seconds', duration)

        if response.status_code >= 500:
            inc('http_errors_5xx')

        return response


# ── Helpers ──────────────────────────────────────────────────────────────────

def _db_stats():
    try:
        with connection.cursor() as c:
            c.execute("SELECT 1")
            db_ok = True
    except Exception:
        db_ok = False

    tables = {}
    try:
        from ionik_auth.models import User
        from ionik_messages.models import Message, Conversation, Guild, GuildMessage

        tables['users'] = User.objects.count()
        tables['conversations'] = Conversation.objects.count()
        tables['messages'] = Message.objects.count()
        tables['guilds'] = Guild.objects.count()
        tables['guild_messages'] = GuildMessage.objects.count()
    except Exception:
        pass

    return {'connected': db_ok, 'tables': tables}


def _redis_stats():
    try:
        import redis as redis_mod
        url = os.environ.get('REDIS_URL', 'redis://127.0.0.1:6379/0')
        r = redis_mod.Redis.from_url(url, socket_connect_timeout=2)
        info = r.info(section='memory')
        clients = r.info(section='clients')
        return {
            'connected': True,
            'used_memory_mb': round(info.get('used_memory', 0) / 1024 / 1024, 2),
            'connected_clients': clients.get('connected_clients', 0),
            'max_memory_mb': round(info.get('maxmemory', 0) / 1024 / 1024, 2),
        }
    except Exception as e:
        return {'connected': False, 'error': str(e)}


def _kafka_stats():
    try:
        from confluent_kafka.admin import AdminClient
        brokers = os.environ.get('KAFKA_BOOTSTRAP_SERVERS', 'localhost:9092')
        admin = AdminClient({'bootstrap.servers': brokers, 'socket.timeout.ms': 3000})
        meta = admin.list_topics(timeout=3)
        topics = {}
        for name, t in meta.topics.items():
            if not name.startswith('__'):
                topics[name] = len(t.partitions)
        return {
            'connected': True,
            'brokers': len(meta.brokers),
            'topics': topics,
        }
    except Exception as e:
        return {'connected': False, 'error': str(e)}


def _system_stats():
    proc = psutil.Process()
    mem = proc.memory_info()
    return {
        'hostname': platform.node(),
        'os': f'{platform.system()} {platform.release()}',
        'python': platform.python_version(),
        'cpu_count': psutil.cpu_count(),
        'cpu_percent': psutil.cpu_percent(interval=0.1),
        'memory': {
            'total_gb': round(psutil.virtual_memory().total / 1024**3, 2),
            'available_gb': round(psutil.virtual_memory().available / 1024**3, 2),
            'percent': psutil.virtual_memory().percent,
        },
        'process': {
            'pid': proc.pid,
            'rss_mb': round(mem.rss / 1024**2, 2),
            'threads': proc.num_threads(),
            'open_files': len(proc.open_files()),
        },
        'disk': {
            'total_gb': round(psutil.disk_usage('/').total / 1024**3, 2),
            'free_gb': round(psutil.disk_usage('/').free / 1024**3, 2),
            'percent': psutil.disk_usage('/').percent,
        },
    }


def _request_stats():
    hist = _histograms.get('http_request_duration_seconds', [])
    if not hist:
        return {'count': 0}

    sorted_h = sorted(hist)
    n = len(sorted_h)
    return {
        'count': _counters.get('http_requests_total', 0),
        'errors_5xx': _counters.get('http_errors_5xx', 0),
        'latency': {
            'avg_ms': round(sum(sorted_h) / n * 1000, 2),
            'p50_ms': round(sorted_h[int(n * 0.5)] * 1000, 2),
            'p95_ms': round(sorted_h[int(n * 0.95)] * 1000, 2),
            'p99_ms': round(sorted_h[min(int(n * 0.99), n - 1)] * 1000, 2),
        },
    }


def _ws_stats():
    from ionik_messages.voice_state import _voice_channels
    voice_users = sum(
        len([k for k in ch.keys() if k != '_guild_id'])
        for ch in _voice_channels.values()
    )
    return {
        'connections_total': _counters.get('ws_connections_total', 0),
        'messages_received': _counters.get('ws_messages_received', 0),
        'messages_sent': _counters.get('ws_messages_sent', 0),
        'voice_channels_active': len(_voice_channels),
        'voice_users': voice_users,
    }


def _channel_layer_stats():
    from channels.layers import get_channel_layer
    layer = get_channel_layer()
    backend = type(layer).__module__ + '.' + type(layer).__name__
    return {
        'backend': backend,
        'is_redis': 'redis' in backend.lower(),
    }


# ── Views ────────────────────────────────────────────────────────────────────

def status_page(request, date_token):
    today = date.today().strftime('%Y-%m-%d')
    if date_token != today:
        return HttpResponse('Not Found', status=404)

    uptime_seconds = int(time.time() - _counters['startup_time'])
    hours, remainder = divmod(uptime_seconds, 3600)
    minutes, secs = divmod(remainder, 60)

    data = {
        'status': 'ok',
        'uptime': f'{hours}h {minutes}m {secs}s',
        'uptime_seconds': uptime_seconds,
        'system': _system_stats(),
        'database': _db_stats(),
        'redis': _redis_stats(),
        'kafka': _kafka_stats(),
        'channel_layer': _channel_layer_stats(),
        'http': _request_stats(),
        'websockets': _ws_stats(),
    }

    return JsonResponse(data, json_dumps_params={'indent': 2, 'ensure_ascii': False})


def prometheus_metrics(request):
    today = date.today().strftime('%Y-%m-%d')
    token = request.GET.get('token', '')
    if token != today:
        return HttpResponse('Forbidden', status=403)

    lines = []

    def gauge(name, value, help_text='', labels=None):
        if help_text:
            lines.append(f'# HELP {name} {help_text}')
            lines.append(f'# TYPE {name} gauge')
        label_str = ''
        if labels:
            label_str = '{' + ','.join(f'{k}="{v}"' for k, v in labels.items()) + '}'
        lines.append(f'{name}{label_str} {value}')

    def counter(name, value, help_text=''):
        if help_text:
            lines.append(f'# HELP {name} {help_text}')
            lines.append(f'# TYPE {name} counter')
        lines.append(f'{name} {value}')

    # System
    sys_stats = _system_stats()
    gauge('ionik_cpu_percent', sys_stats['cpu_percent'], 'System CPU usage percent')
    gauge('ionik_memory_percent', sys_stats['memory']['percent'], 'System memory usage percent')
    gauge('ionik_memory_available_bytes', int(sys_stats['memory']['available_gb'] * 1024**3), 'Available system memory')
    gauge('ionik_process_rss_bytes', int(sys_stats['process']['rss_mb'] * 1024**2), 'Process RSS memory')
    gauge('ionik_process_threads', sys_stats['process']['threads'], 'Process thread count')
    gauge('ionik_disk_percent', sys_stats['disk']['percent'], 'Disk usage percent')
    gauge('ionik_uptime_seconds', int(time.time() - _counters['startup_time']), 'Server uptime')

    # HTTP
    counter('ionik_http_requests_total', _counters.get('http_requests_total', 0), 'Total HTTP requests')
    counter('ionik_http_errors_5xx_total', _counters.get('http_errors_5xx', 0), 'Total 5xx errors')

    req_stats = _request_stats()
    if req_stats['count'] > 0:
        gauge('ionik_http_latency_p50_ms', req_stats['latency']['p50_ms'], 'HTTP p50 latency ms')
        gauge('ionik_http_latency_p95_ms', req_stats['latency']['p95_ms'], 'HTTP p95 latency ms')
        gauge('ionik_http_latency_p99_ms', req_stats['latency']['p99_ms'], 'HTTP p99 latency ms')

    # WebSocket
    counter('ionik_ws_connections_total', _counters.get('ws_connections_total', 0), 'Total WS connections')
    counter('ionik_ws_messages_received_total', _counters.get('ws_messages_received', 0), 'Total WS messages received')
    counter('ionik_ws_messages_sent_total', _counters.get('ws_messages_sent', 0), 'Total WS messages sent')

    ws = _ws_stats()
    gauge('ionik_voice_channels_active', ws['voice_channels_active'], 'Active voice channels')
    gauge('ionik_voice_users', ws['voice_users'], 'Users in voice channels')

    # DB
    db = _db_stats()
    gauge('ionik_db_connected', 1 if db['connected'] else 0, 'Database connection status')
    for table, count in db.get('tables', {}).items():
        gauge('ionik_db_rows', count, labels={'table': table})

    # Redis
    redis_info = _redis_stats()
    gauge('ionik_redis_connected', 1 if redis_info.get('connected') else 0, 'Redis connection status')
    if redis_info.get('connected'):
        gauge('ionik_redis_memory_bytes', int(redis_info.get('used_memory_mb', 0) * 1024**2), 'Redis used memory')
        gauge('ionik_redis_clients', redis_info.get('connected_clients', 0), 'Redis connected clients')

    # Kafka
    kafka_info = _kafka_stats()
    gauge('ionik_kafka_connected', 1 if kafka_info.get('connected') else 0, 'Kafka connection status')
    if kafka_info.get('connected'):
        gauge('ionik_kafka_brokers', kafka_info.get('brokers', 0), 'Kafka broker count')

    content = '\n'.join(lines) + '\n'
    return HttpResponse(content, content_type='text/plain; version=0.0.4; charset=utf-8')
