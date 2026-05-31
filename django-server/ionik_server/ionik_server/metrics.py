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
    # DM calls tracked via SignalingConsumer._users
    try:
        from ionik_signaling.consumers import SignalingConsumer
        signaling_users = SignalingConsumer._users
        online_users = len(signaling_users)
        active_calls = len([u for u in signaling_users.values() if u.get('in_call_with')])
        # Each call has 2 participants, so divide by 2
        active_calls_count = active_calls // 2 if active_calls > 1 else active_calls
    except Exception:
        online_users = 0
        active_calls_count = 0

    return {
        'connections_total': _counters.get('ws_connections_total', 0),
        'messages_received': _counters.get('ws_messages_received', 0),
        'messages_sent': _counters.get('ws_messages_sent', 0),
        'voice_channels_active': len(_voice_channels),
        'voice_users': voice_users,
        'online_users': online_users,
        'active_dm_calls': active_calls_count,
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

def _status_json(request):
    uptime_seconds = int(time.time() - _counters['startup_time'])
    hours, remainder = divmod(uptime_seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    return {
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


def status_page(request, date_token):
    today = date.today().strftime('%Y-%m-%d')
    if date_token != today:
        return HttpResponse('Not Found', status=404)

    if request.GET.get('format') == 'json':
        return JsonResponse(_status_json(request), json_dumps_params={'indent': 2, 'ensure_ascii': False})

    import json
    data = _status_json(request)
    data_json = json.dumps(data, ensure_ascii=False)

    html = _STATUS_HTML_TEMPLATE.replace('__DATA__', data_json).replace('__DATE__', today)
    return HttpResponse(html, content_type='text/html')


_STATUS_HTML_TEMPLATE = r'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ionik Status — __DATE__</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;padding:20px}
h1{font-size:22px;margin-bottom:20px;color:#58a6ff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;margin-bottom:24px}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;position:relative;overflow:hidden}
.card h3{font-size:13px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}
.metric{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #21262d}
.metric:last-child{border-bottom:none}
.metric .label{color:#8b949e;font-size:13px}
.metric .value{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600}
.badge.up{background:#1a3a2a;color:#3fb950}
.badge.down{background:#3d1a1a;color:#f85149}
.gauge-row{display:flex;gap:16px;margin-bottom:24px}
.gauge-card{flex:1;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;text-align:center}
.gauge-card .gauge-label{font-size:12px;color:#8b949e;text-transform:uppercase;margin-bottom:8px}
.gauge-card .gauge-value{font-size:36px;font-weight:700;font-variant-numeric:tabular-nums}
.gauge-card .gauge-sub{font-size:12px;color:#8b949e;margin-top:4px}
.bar-wrap{height:8px;background:#21262d;border-radius:4px;margin-top:8px;overflow:hidden}
.bar-fill{height:100%;border-radius:4px;transition:width .3s}
.green{color:#3fb950}.yellow{color:#d29922}.red{color:#f85149}.blue{color:#58a6ff}.purple{color:#bc8cff}
.bar-fill.green-bg{background:#3fb950}.bar-fill.yellow-bg{background:#d29922}.bar-fill.red-bg{background:#f85149}
.chart-area{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;margin-bottom:24px}
.chart-area h3{font-size:13px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}
canvas{width:100%!important;height:200px!important}
.refresh-bar{text-align:center;padding:12px;color:#484f58;font-size:12px}
</style>
</head>
<body>
<h1>&#x1f4ca; Ionik Server Status</h1>

<div class="gauge-row" id="gauges"></div>
<div class="grid" id="cards"></div>
<div class="chart-area"><h3>HTTP Latency</h3><canvas id="latencyChart"></canvas></div>
<div class="chart-area"><h3>Database Rows</h3><canvas id="dbChart"></canvas></div>
<div class="refresh-bar">Auto-refresh every 10s &middot; <span id="lastUpdate"></span></div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<script>
const DATA = __DATA__;

function colorForPercent(v){return v<60?'green':v<85?'yellow':'red'}
function barClass(v){return v<60?'green-bg':v<85?'yellow-bg':'red-bg'}
function fmtBytes(b){if(b>1e9)return(b/1e9).toFixed(2)+' GB';if(b>1e6)return(b/1e6).toFixed(1)+' MB';return(b/1024).toFixed(0)+' KB'}

function renderGauges(d){
  const g=document.getElementById('gauges');
  const items=[
    {label:'Uptime',value:d.uptime,sub:'',cls:'blue'},
    {label:'CPU',value:d.system.cpu_percent+'%',sub:d.system.cpu_count+' cores',cls:colorForPercent(d.system.cpu_percent),pct:d.system.cpu_percent},
    {label:'Memory',value:d.system.memory.percent+'%',sub:fmtBytes(d.system.memory.available_gb*1e9)+' free',cls:colorForPercent(d.system.memory.percent),pct:d.system.memory.percent},
    {label:'Disk',value:d.system.disk.percent+'%',sub:d.system.disk.free_gb+' GB free',cls:colorForPercent(d.system.disk.percent),pct:d.system.disk.percent},
    {label:'Process RSS',value:d.system.process.rss_mb+' MB',sub:'PID '+d.system.process.pid,cls:'purple'},
    {label:'Threads',value:d.system.process.threads,sub:d.system.process.open_files+' open files',cls:'purple'},
  ];
  g.innerHTML=items.map(i=>`
    <div class="gauge-card">
      <div class="gauge-label">${i.label}</div>
      <div class="gauge-value ${i.cls}">${i.value}</div>
      <div class="gauge-sub">${i.sub}</div>
      ${i.pct!=null?`<div class="bar-wrap"><div class="bar-fill ${barClass(i.pct)}" style="width:${i.pct}%"></div></div>`:''}
    </div>
  `).join('');
}

function metricRow(label,value,cls){return`<div class="metric"><span class="label">${label}</span><span class="value ${cls||''}">${value}</span></div>`}
function badge(up){return`<span class="badge ${up?'up':'down'}">${up?'UP':'DOWN'}</span>`}

function renderCards(d){
  const c=document.getElementById('cards');
  let cards='';

  // HTTP
  const h=d.http;
  cards+=`<div class="card"><h3>HTTP</h3>
    ${metricRow('Total Requests',h.count.toLocaleString())}
    ${metricRow('5xx Errors',h.errors_5xx,'red')}
    ${h.latency?metricRow('p50 Latency',h.latency.p50_ms+' ms'):''}
    ${h.latency?metricRow('p95 Latency',h.latency.p95_ms+' ms','yellow'):''}
    ${h.latency?metricRow('p99 Latency',h.latency.p99_ms+' ms','red'):''}
  </div>`;

  // WebSocket
  const w=d.websockets;
  cards+=`<div class="card"><h3>WebSocket</h3>
    ${metricRow('Connections',w.connections_total.toLocaleString())}
    ${metricRow('Messages In',w.messages_received.toLocaleString())}
    ${metricRow('Messages Out',w.messages_sent.toLocaleString())}
    ${metricRow('Voice Channels',w.voice_channels_active)}
    ${metricRow('Voice Users',w.voice_users)}
    ${metricRow('Online Users',w.online_users,'blue')}
    ${metricRow('Active DM Calls',w.active_dm_calls,'green')}
  </div>`;

  // Database
  const db=d.database;
  cards+=`<div class="card"><h3>Database</h3>
    ${metricRow('Status',badge(db.connected))}
    ${Object.entries(db.tables||{}).map(([k,v])=>metricRow(k,v.toLocaleString())).join('')}
  </div>`;

  // Redis
  const r=d.redis;
  cards+=`<div class="card"><h3>Redis</h3>
    ${metricRow('Status',badge(r.connected))}
    ${r.connected?metricRow('Memory',r.used_memory_mb+' MB'):''}
    ${r.connected?metricRow('Clients',r.connected_clients):''}
    ${r.error?metricRow('Error',r.error,'red'):''}
  </div>`;

  // Kafka
  const k=d.kafka;
  cards+=`<div class="card"><h3>Kafka</h3>
    ${metricRow('Status',badge(k.connected))}
    ${k.connected?metricRow('Brokers',k.brokers):''}
    ${k.topics?Object.entries(k.topics).map(([t,p])=>metricRow(t,p+' partitions')).join(''):''}
    ${k.error?metricRow('Error',k.error,'red'):''}
  </div>`;

  // Channel Layer
  const cl=d.channel_layer;
  cards+=`<div class="card"><h3>Channel Layer</h3>
    ${metricRow('Backend',cl.is_redis?'Redis':'InMemory',cl.is_redis?'green':'yellow')}
  </div>`;

  // System
  cards+=`<div class="card"><h3>System</h3>
    ${metricRow('Hostname',d.system.hostname)}
    ${metricRow('OS',d.system.os)}
    ${metricRow('Python',d.system.python)}
  </div>`;

  c.innerHTML=cards;
}

function renderCharts(d){
  // Latency chart
  const ctx1=document.getElementById('latencyChart').getContext('2d');
  if(d.http.latency){
    new Chart(ctx1,{
      type:'bar',
      data:{
        labels:['p50','p95','p99'],
        datasets:[{
          data:[d.http.latency.p50_ms,d.http.latency.p95_ms,d.http.latency.p99_ms],
          backgroundColor:['#3fb950','#d29922','#f85149'],
          borderRadius:6,
          barThickness:60,
        }]
      },
      options:{
        responsive:true,
        plugins:{legend:{display:false}},
        scales:{
          y:{ticks:{color:'#8b949e',callback:v=>v+' ms'},grid:{color:'#21262d'}},
          x:{ticks:{color:'#8b949e'},grid:{display:false}}
        }
      }
    });
  }

  // DB rows chart
  const ctx2=document.getElementById('dbChart').getContext('2d');
  const tables=d.database.tables||{};
  const labels=Object.keys(tables);
  const values=Object.values(tables);
  if(labels.length){
    new Chart(ctx2,{
      type:'bar',
      data:{
        labels:labels,
        datasets:[{
          data:values,
          backgroundColor:['#58a6ff','#bc8cff','#3fb950','#d29922','#f85149','#79c0ff'],
          borderRadius:6,
          barThickness:50,
        }]
      },
      options:{
        responsive:true,
        plugins:{legend:{display:false}},
        scales:{
          y:{ticks:{color:'#8b949e'},grid:{color:'#21262d'}},
          x:{ticks:{color:'#8b949e'},grid:{display:false}}
        }
      }
    });
  }
}

renderGauges(DATA);
renderCards(DATA);
renderCharts(DATA);
document.getElementById('lastUpdate').textContent='Updated: '+new Date().toLocaleTimeString();

setInterval(()=>{
  fetch(location.href+(location.href.includes('?')?'&':'?')+'format=json')
    .then(r=>r.json())
    .then(d=>{
      renderGauges(d);
      renderCards(d);
      document.getElementById('lastUpdate').textContent='Updated: '+new Date().toLocaleTimeString();
    }).catch(()=>{});
},10000);
</script>
</body>
</html>'''


def _is_internal(request):
    ip = request.META.get('REMOTE_ADDR', '')
    forwarded = request.META.get('HTTP_X_FORWARDED_FOR', '')
    real_ip = forwarded.split(',')[0].strip() if forwarded else ip
    return real_ip in ('127.0.0.1', '::1', '10.0.0.0/8') or real_ip.startswith(('172.', '10.', '192.168.'))


def prometheus_metrics(request):
    today = date.today().strftime('%Y-%m-%d')
    token = request.GET.get('token', '')
    if token != today and not _is_internal(request):
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
    gauge('ionik_online_users', ws['online_users'], 'Online users (signaling WS)')
    gauge('ionik_active_dm_calls', ws['active_dm_calls'], 'Active DM calls')

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
