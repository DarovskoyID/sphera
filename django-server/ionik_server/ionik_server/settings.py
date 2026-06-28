import os
from pathlib import Path
from datetime import timedelta

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = 'django-insecure-e_-am06**zcqtimkp^2))-uxv$k99wiv2svgs^o300#sgrt+b@'

DEBUG = True

ALLOWED_HOSTS = ['*']

IONIK_DOMAIN = os.environ.get('IONIK_DOMAIN', 'start-ionik.ru')
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
    # Local apps
    'ionik_auth',
    'ionik_messages',
    'ionik_signaling',
]

MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'ionik_server.middleware.AppOnlyMiddleware',
    'django.middleware.security.SecurityMiddleware',
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
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
]

# CORS — allow React dev server and custom app header
CORS_ALLOW_ALL_ORIGINS = True
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

# DRF
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': (
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ),
}

# JWT
SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(days=7),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=30),
}

# Fernet key for encrypting chat messages at rest
MESSAGE_ENCRYPTION_KEY = 'B_jCzvYRndN90PQCee5x7RwE5R-AjJ_WN_m0d3beh1Q='

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
