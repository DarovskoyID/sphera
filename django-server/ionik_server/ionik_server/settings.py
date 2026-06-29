import os
from pathlib import Path
from datetime import timedelta
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent


def _env_bool(name, default=False):
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in ('1', 'true', 'yes', 'on')


# ── Core secrets ─────────────────────────────────────────────────────────────
# Secrets are read from the environment. The hardcoded fallbacks below exist only
# so local development keeps working without setup; they are the (already leaked)
# legacy values, so PRODUCTION MUST override them via env and they should be
# rotated.
# DEBUG defaults to OFF. Local dev opts in with IONIK_DEBUG=1.
DEBUG = _env_bool('IONIK_DEBUG', False)

_DEV_SECRET_KEY = 'ionik-local-development-secret-key-not-for-production'
SECRET_KEY = os.environ.get('IONIK_SECRET_KEY') or (_DEV_SECRET_KEY if DEBUG else '')
if not SECRET_KEY:
    raise ImproperlyConfigured('IONIK_SECRET_KEY must be set when IONIK_DEBUG=0.')

# Restrict the Host header. Defaults to localhost + the configured domain;
# extend via IONIK_ALLOWED_HOSTS (comma-separated). '*' only if explicitly asked.
# host.docker.internal — чтобы Prometheus (docker) мог скрейпить /metrics через
# nginx по этому Host без 400 (DisallowedHost).
ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']
_extra_hosts = os.environ.get('IONIK_ALLOWED_HOSTS', '')
if _extra_hosts.strip() == '*':
    ALLOWED_HOSTS = ['*']
elif _extra_hosts:
    ALLOWED_HOSTS.extend(h.strip() for h in _extra_hosts.split(',') if h.strip())

IONIK_DOMAIN = os.environ.get('IONIK_DOMAIN', 'start-ionik.ru')
# The production domain is always a valid Host.
if IONIK_DOMAIN and IONIK_DOMAIN not in ALLOWED_HOSTS and ALLOWED_HOSTS != ['*']:
    ALLOWED_HOSTS.append(IONIK_DOMAIN)

IONIK_CSRF_ORIGINS = os.environ.get('IONIK_CSRF_ORIGINS', '')

# When served over TLS the browser sends the Origin / Referer with https://.
# Django CSRF rejects requests if the origin isn't whitelisted explicitly.
CSRF_TRUSTED_ORIGINS = [
    f'https://{IONIK_DOMAIN}',
    f'https://{IONIK_DOMAIN}:8000',
    'https://localhost',
    'https://localhost:8000',
]
if IONIK_CSRF_ORIGINS:
    CSRF_TRUSTED_ORIGINS.extend(
        origin.strip()
        for origin in IONIK_CSRF_ORIGINS.split(',')
        if origin.strip()
    )
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')

# ── Transport / browser hardening ────────────────────────────────────────────
# Enforced only outside DEBUG so local HTTP development is unaffected.
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = 'same-origin'
X_FRAME_OPTIONS = 'DENY'
if not DEBUG:
    SECURE_SSL_REDIRECT = _env_bool('IONIK_SSL_REDIRECT', True)
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SESSION_COOKIE_HTTPONLY = True
    SECURE_HSTS_SECONDS = int(os.environ.get('IONIK_HSTS_SECONDS', '31536000'))
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True

INSTALLED_APPS = [
    'daphne',
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    # Third-party
    'rest_framework',
    'corsheaders',
    'channels',
    'rest_framework_simplejwt.token_blacklist',
    # Local apps
    'ionik_auth',
    'ionik_messages',
    'ionik_signaling',
]

MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'ionik_server.middleware.AppOnlyMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'ionik_server.middleware.SecurityHeadersMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
    'ionik_server.metrics.MetricsMiddleware',
]

ROOT_URLCONF = 'ionik_server.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'ionik_server.wsgi.application'
ASGI_APPLICATION = 'ionik_server.asgi.application'

# Channel layer: Redis if available, fallback to InMemory
_REDIS_URL = os.environ.get('REDIS_URL', 'redis://127.0.0.1:6379/0')
_USE_REDIS = os.environ.get('USE_REDIS_CHANNEL_LAYER', '').lower() in ('1', 'true', 'yes')

if not _USE_REDIS:
    try:
        import redis as _redis_mod
        _r = _redis_mod.Redis.from_url(_REDIS_URL, socket_connect_timeout=1)
        _r.ping()
        _USE_REDIS = True
    except Exception:
        _USE_REDIS = False

if _USE_REDIS:
    CHANNEL_LAYERS = {
        'default': {
            'BACKEND': 'channels_redis.core.RedisChannelLayer',
            'CONFIG': {
                'hosts': [_REDIS_URL],
                'capacity': 1500,
                'expiry': 10,
            },
        },
    }
else:
    CHANNEL_LAYERS = {
        'default': {
            'BACKEND': 'channels.layers.InMemoryChannelLayer',
        },
    }

# Django cache backend: Redis (shared across workers) if available, else local memory.
# The explore/search endpoint leans on this heavily under high traffic.
if _USE_REDIS:
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.redis.RedisCache',
            'LOCATION': _REDIS_URL,
            'KEY_PREFIX': 'ionik',
        }
    }
else:
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
            'LOCATION': 'ionik-locmem',
        }
    }

# Kafka for durable message processing pipeline
KAFKA_ENABLED = os.environ.get('KAFKA_ENABLED', 'false').lower() in ('1', 'true', 'yes')
KAFKA_BOOTSTRAP_SERVERS = os.environ.get('KAFKA_BOOTSTRAP_SERVERS', 'localhost:9092')

# БД выбирается окружением: если задан POSTGRES_DB — используем Postgres
# (прод-сервер), иначе sqlite (локальная разработка). Так локалка не требует
# поднятого Postgres, а сервер работает на нём же без правки кода.
if os.environ.get('POSTGRES_DB'):
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.postgresql',
            'NAME': os.environ['POSTGRES_DB'],
            'USER': os.environ.get('POSTGRES_USER', 'ionik'),
            'PASSWORD': os.environ.get('POSTGRES_PASSWORD', ''),
            'HOST': os.environ.get('POSTGRES_HOST', '127.0.0.1'),
            'PORT': os.environ.get('POSTGRES_PORT', '5432'),
            'CONN_MAX_AGE': 60,
        }
    }
else:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': BASE_DIR / 'db.sqlite3',
        }
    }

AUTH_USER_MODEL = 'ionik_auth.User'

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
        'OPTIONS': {'min_length': 8},
    },
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

# CORS — locked down in production. In DEBUG any origin is allowed (React dev
# server, Electron, mobile WebView). In production only the configured origins
# are accepted, unless IONIK_CORS_ALLOW_ALL=1 is set as an escape hatch for
# clients that send an unexpected Origin.
if DEBUG or _env_bool('IONIK_CORS_ALLOW_ALL', False):
    CORS_ALLOW_ALL_ORIGINS = True
else:
    CORS_ALLOW_ALL_ORIGINS = False
    CORS_ALLOWED_ORIGINS = list(CSRF_TRUSTED_ORIGINS)
    _cors_extra = os.environ.get('IONIK_CORS_ORIGINS', '')
    if _cors_extra:
        CORS_ALLOWED_ORIGINS.extend(
            o.strip() for o in _cors_extra.split(',') if o.strip()
        )
CORS_ALLOW_HEADERS = [
    'accept',
    'accept-encoding',
    'authorization',
    'content-type',
    'dnt',
    'origin',
    'user-agent',
    'x-csrftoken',
    'x-requested-with',
    'x-ionik-client',
]
CORS_ALLOW_CREDENTIALS = True

CONTENT_SECURITY_POLICY = os.environ.get(
    'IONIK_CONTENT_SECURITY_POLICY',
    "default-src 'self'; "
    "base-uri 'self'; "
    "object-src 'none'; "
    "frame-ancestors 'none'; "
    "img-src 'self' data: blob: https:; "
    "media-src 'self' blob: https:; "
    "font-src 'self' data:; "
    "style-src 'self' 'unsafe-inline'; "
    "script-src 'self'; "
    "connect-src 'self' https: http: ws: wss:; "
    "form-action 'self'; "
    "upgrade-insecure-requests"
)
UPLOAD_SCAN_COMMAND = os.environ.get('IONIK_UPLOAD_SCAN_COMMAND', '')

# DRF
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': (
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ),
    # Rate limiting to blunt brute-force / enumeration against auth endpoints.
    'DEFAULT_THROTTLE_CLASSES': (
        'rest_framework.throttling.AnonRateThrottle',
        'rest_framework.throttling.UserRateThrottle',
        'rest_framework.throttling.ScopedRateThrottle',
    ),
    'DEFAULT_THROTTLE_RATES': {
        'anon': os.environ.get('IONIK_THROTTLE_ANON', '60/min'),
        'user': os.environ.get('IONIK_THROTTLE_USER', '1000/min'),
        # Tight bucket for credential / account-sensitive endpoints.
        'auth': os.environ.get('IONIK_THROTTLE_AUTH', '10/min'),
    },
}

# JWT access tokens are intentionally short-lived; the web client refreshes them
# with /api/auth/refresh/ and retries authenticated requests once after 401.
SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(
        minutes=int(os.environ.get('IONIK_ACCESS_TOKEN_MINUTES', '15'))
    ),
    'REFRESH_TOKEN_LIFETIME': timedelta(
        days=int(os.environ.get('IONIK_REFRESH_TOKEN_DAYS', '14'))
    ),
    'ROTATE_REFRESH_TOKENS': True,
    'BLACKLIST_AFTER_ROTATION': True,
    'UPDATE_LAST_LOGIN': True,
}

REFRESH_COOKIE_NAME = os.environ.get('IONIK_REFRESH_COOKIE_NAME', 'ionik_refresh')
REFRESH_COOKIE_PATH = os.environ.get('IONIK_REFRESH_COOKIE_PATH', '/api/auth/')
REFRESH_COOKIE_SECURE = _env_bool('IONIK_REFRESH_COOKIE_SECURE', not DEBUG)
REFRESH_COOKIE_SAMESITE = os.environ.get('IONIK_REFRESH_COOKIE_SAMESITE', 'Lax')

# Fernet key for encrypting chat messages at rest. Production must set a real
# key. DEBUG uses a stable, public dev-only key so local setup remains easy.
_DEV_MESSAGE_KEY = 'wHWdqFBtktDisD5K62xhK5cWhYfYcTXwDZSF6xgeHJg='
MESSAGE_ENCRYPTION_KEY = (
    os.environ.get('IONIK_MESSAGE_ENCRYPTION_KEY')
    or (_DEV_MESSAGE_KEY if DEBUG else '')
)
if not MESSAGE_ENCRYPTION_KEY:
    raise ImproperlyConfigured(
        'IONIK_MESSAGE_ENCRYPTION_KEY must be set when IONIK_DEBUG=0.'
    )
OLD_MESSAGE_ENCRYPTION_KEYS = [
    key.strip()
    for key in os.environ.get('IONIK_OLD_MESSAGE_ENCRYPTION_KEYS', '').split(',')
    if key.strip()
]

# ==================== TURN / звонки (горизонтальное масштабирование) ===========
# Пул TURN-нод: "host:port,host:port,...". Эндпоинт /api/turn/ выдаёт клиенту одну
# ноду round-robin → нагрузка звонков размазывается. Пусто → одна нода (realm).
IONIK_TURN_NODES = os.environ.get('IONIK_TURN_NODES', '')
IONIK_TURN_REALM = os.environ.get('IONIK_TURN_REALM', IONIK_DOMAIN)
IONIK_TURN_PORT = int(os.environ.get('IONIK_TURN_PORT', '3478'))
# Общий секрет → ВРЕМЕННЫЕ креды (coturn use-auth-secret), валидны на любой ноде с
# тем же секретом. Иначе — статический user/pass.
IONIK_TURN_SECRET = os.environ.get('IONIK_TURN_SECRET', '')
IONIK_TURN_TTL = int(os.environ.get('IONIK_TURN_TTL', '3600'))
IONIK_TURN_USER = os.environ.get('IONIK_TURN_USER', 'ionikuser')
IONIK_TURN_PASS = os.environ.get('IONIK_TURN_PASS', 'ionikturn123')

# ==================== Email (sign-up verification) ====================
# When SMTP credentials are supplied via the environment we send real mail;
# otherwise (local dev) the code is printed to the server console so the flow
# is testable without an SMTP server.
EMAIL_HOST = os.environ.get('EMAIL_HOST', '')
if EMAIL_HOST:
    EMAIL_BACKEND = 'django.core.mail.backends.smtp.EmailBackend'
    EMAIL_PORT = int(os.environ.get('EMAIL_PORT', '587'))
    EMAIL_HOST_USER = os.environ.get('EMAIL_HOST_USER', '')
    EMAIL_HOST_PASSWORD = os.environ.get('EMAIL_HOST_PASSWORD', '')
    EMAIL_USE_TLS = os.environ.get('EMAIL_USE_TLS', 'true').lower() in ('1', 'true', 'yes')
    EMAIL_USE_SSL = os.environ.get('EMAIL_USE_SSL', '').lower() in ('1', 'true', 'yes')
else:
    EMAIL_BACKEND = 'django.core.mail.backends.console.EmailBackend'

DEFAULT_FROM_EMAIL = os.environ.get(
    'DEFAULT_FROM_EMAIL', f'Ionik <no-reply@{IONIK_DOMAIN}>'
)

# Lifetime of a verification code, and the minimum gap between resends.
EMAIL_CODE_TTL_MINUTES = int(os.environ.get('EMAIL_CODE_TTL_MINUTES', '15'))
EMAIL_CODE_RESEND_SECONDS = int(os.environ.get('EMAIL_CODE_RESEND_SECONDS', '60'))
EMAIL_CODE_MAX_ATTEMPTS = int(os.environ.get('EMAIL_CODE_MAX_ATTEMPTS', '5'))

# Firebase service account key — download from:
# Firebase Console → Project Settings → Service Accounts → Generate new private key
FIREBASE_CREDENTIALS = BASE_DIR / 'serviceAccountKey.json'

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True
STATIC_URL = 'static/'
MEDIA_URL = '/media/'
MEDIA_ROOT = os.path.join(BASE_DIR, 'media')
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
