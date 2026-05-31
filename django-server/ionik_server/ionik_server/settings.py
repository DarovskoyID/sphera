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

# Kafka for durable message processing pipeline
KAFKA_ENABLED = os.environ.get('KAFKA_ENABLED', 'false').lower() in ('1', 'true', 'yes')
KAFKA_BOOTSTRAP_SERVERS = os.environ.get('KAFKA_BOOTSTRAP_SERVERS', 'localhost:9092')

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
