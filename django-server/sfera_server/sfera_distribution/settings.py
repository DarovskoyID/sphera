"""Explicit distributed application service; no legacy personal-server imports.

Configuration is a private, per-entry local file. There is no default secret,
shared application database, Redis broker or password-based mesh login.
"""
import json
import os
from pathlib import Path
from datetime import timedelta
from django.core.exceptions import ImproperlyConfigured

config_path=Path(os.environ.get('SFERA_DISTRIBUTED_CONFIG',''))
if not config_path.is_absolute() or config_path.is_symlink() or not config_path.is_file():
    raise ImproperlyConfigured('An absolute private distributed application configuration is required.')
if os.name!='nt' and config_path.stat().st_mode & 0o077:
    raise ImproperlyConfigured('The application configuration must be private to its service account.')
if config_path.stat().st_size>32768:raise ImproperlyConfigured('Application configuration is too large.')
config=json.loads(config_path.read_bytes())
required={'secret_key','message_encryption_key','database','allowed_hosts','mesh'}
if set(config) not in (required,required|{'local_consensus_rpc'}):
    raise ImproperlyConfigured('Invalid distributed application configuration.')
if not isinstance(config['secret_key'],str) or len(config['secret_key'])<64:
    raise ImproperlyConfigured('A separate random application signing secret is required.')
if (not isinstance(config['allowed_hosts'],list) or not config['allowed_hosts']
        or any(not isinstance(host,str) or not host or '*' in host or '/' in host for host in config['allowed_hosts'])):
    raise ImproperlyConfigured('Explicit application hosts are required.')
database=Path(config['database'])
if not database.is_absolute() or database.is_symlink():raise ImproperlyConfigured('An absolute separate application database is required.')
if config['mesh'].get('identity_policy')!='consensus-profile-v1':raise ImproperlyConfigured('Consensus-owned application identities are required.')
if str(database.resolve()) in {str(Path(config['mesh'][name]).resolve()) for name in ('state','sessions','identity','genesis','verifier')}:
    raise ImproperlyConfigured('Application data and mesh runtime files must remain separate.')
from cryptography.fernet import Fernet
try:Fernet(config['message_encryption_key'].encode('ascii'))
except (ValueError,TypeError,KeyError,UnicodeError) as exc:raise ImproperlyConfigured('Invalid local projection encryption key.') from exc

BASE_DIR=Path(__file__).resolve().parent.parent
SECRET_KEY=config['secret_key'];DEBUG=False;ALLOWED_HOSTS=config['allowed_hosts']
INSTALLED_APPS=['django.contrib.auth','django.contrib.contenttypes','sfera_auth','sfera_messages',
                'sfera_modules','sfera_distribution','rest_framework_simplejwt.token_blacklist']
AUTH_USER_MODEL='sfera_auth.User';DEFAULT_AUTO_FIELD='django.db.models.BigAutoField'
USE_TZ=True;TIME_ZONE='UTC'
DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':str(database),'OPTIONS':{'timeout':20}}}
SFERA_DEPLOYMENT_MODE='mesh';SFERA_DISTRIBUTED_APPLICATION=True
SFERA_MESH_SESSIONS=config['mesh'];SFERA_MESH_GLOBAL_CIPHER_PINS=True
SFERA_LOCAL_CONSENSUS_RPC=config.get('local_consensus_rpc',config['mesh']['rpc'])
MESSAGE_ENCRYPTION_KEY=config['message_encryption_key']
ROOT_URLCONF='sfera_distribution.service_urls'
WSGI_APPLICATION='sfera_distribution.wsgi.application'
MIDDLEWARE=['django.middleware.security.SecurityMiddleware','django.middleware.common.CommonMiddleware']
SECURE_PROXY_SSL_HEADER=('HTTP_X_FORWARDED_PROTO','https')
SECURE_CONTENT_TYPE_NOSNIFF=True
DATA_UPLOAD_MAX_MEMORY_SIZE=262144;FILE_UPLOAD_MAX_MEMORY_SIZE=0
REST_FRAMEWORK={'DEFAULT_AUTHENTICATION_CLASSES':['sfera_auth.mesh_sessions.MeshJWTAuthentication'],
                'DEFAULT_PERMISSION_CLASSES':['rest_framework.permissions.IsAuthenticated'],
                'DEFAULT_THROTTLE_RATES':{'auth':'60/min','anon':'120/min','user':'600/min'}}
SIMPLE_JWT={'ACCESS_TOKEN_LIFETIME':timedelta(minutes=15),'REFRESH_TOKEN_LIFETIME':timedelta(hours=24),
            'ROTATE_REFRESH_TOKENS':True,'BLACKLIST_AFTER_ROTATION':True}
REFRESH_COOKIE_NAME='sphere_refresh';REFRESH_COOKIE_PATH='/api/auth/'
REFRESH_COOKIE_SECURE=True;REFRESH_COOKIE_SAMESITE='Strict'
APP_USER_AGENT_TOKEN='Sphere';APP_REFRESH_TOKEN_LIFETIME=timedelta(hours=24)
CHANNEL_LAYERS={'default':{'BACKEND':'channels.layers.InMemoryChannelLayer'}}
