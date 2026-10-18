"""Data-only commercial API bridge. Instance credentials never reach the browser."""
import json
import math
import os
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, HTTPRedirectHandler, build_opener
from django.conf import settings

MODULE_IDS = frozenset(('amocrm', 'bitrix', 'onec', 'office', 'whiteboard', 'planner', 'conference', 'servers', 'channels', 'bots', 'diary', 'family', 'legal', 'multiserver', 'totp'))
IDENTIFIER = re.compile(r'^[a-z][a-z0-9_-]{0,63}$')
MAX_RESPONSE = 262144

class CommercialError(Exception):
    def __init__(self, code, status=503):
        self.code, self.status = code, status
        super().__init__(code)

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def config():
    def setting(name): return getattr(settings, name, os.environ.get(name, ''))
    base = str(setting('SFERA_COMMERCIAL_API_URL')).rstrip('/')
    instance = str(setting('SFERA_COMMERCIAL_INSTANCE_ID'))
    token = str(setting('SFERA_COMMERCIAL_API_KEY'))
    if not base or not instance or not token: raise CommercialError('commercial_not_configured')
    parsed = urlparse(base)
    local = parsed.hostname in ('127.0.0.1', 'localhost', '::1')
    if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname:
        raise CommercialError('commercial_invalid_configuration')
    if parsed.scheme != 'https' and not (local and parsed.scheme == 'http'):
        raise CommercialError('commercial_invalid_configuration')
    return base, instance, token

def values_checked(value):
    if not isinstance(value, dict) or len(value) > 100: raise CommercialError('invalid_values', 400)
    for key, cell in value.items():
        if not isinstance(key, str) or not IDENTIFIER.fullmatch(key) or key in ('constructor', 'prototype', '__proto__'):
            raise CommercialError('invalid_values', 400)
        if isinstance(cell, str):
            if len(cell) > 4000: raise CommercialError('invalid_values', 400)
        elif cell is not None and not isinstance(cell, (bool, int, float)):
            raise CommercialError('invalid_values', 400)
        elif isinstance(cell, float) and not math.isfinite(cell):
            raise CommercialError('invalid_values', 400)
    return value

def call(user, module_id=None, action_id=None, values=None):
    base, instance, token = config()
    path = '/v1/catalog'
    if module_id is not None:
        if module_id not in MODULE_IDS: raise CommercialError('unknown_module', 404)
        path = f'/v1/modules/{module_id}/view'
    if action_id is not None:
        if module_id is None or not IDENTIFIER.fullmatch(action_id): raise CommercialError('unknown_action', 400)
        path = f'/v1/modules/{module_id}/actions/{action_id}'
    payload = {'instance_id': instance, 'actor': str(user.id)}
    if values is not None: payload['values'] = values_checked(values)
    encoded = json.dumps(payload, allow_nan=False).encode()
    if len(encoded) > 65536: raise CommercialError('request_too_large', 413)
    request = Request(base + path, data=encoded, headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json', 'Accept': 'application/json'}, method='POST')
    try:
        with build_opener(NoRedirect()).open(request, timeout=8) as response:
            if response.headers.get_content_type() != 'application/json': raise CommercialError('commercial_invalid_response', 502)
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE: raise CommercialError('commercial_invalid_response', 502)
            result = json.loads(data)
            if not isinstance(result, dict): raise CommercialError('commercial_invalid_response', 502)
            return result
    except HTTPError as error:
        codes = {401: 'commercial_credentials_invalid', 403: 'subscription_required', 404: 'commercial_not_found', 503: 'module_migration_pending'}
        raise CommercialError(codes.get(error.code, 'commercial_unavailable'), error.code if error.code in codes else 502) from None
    except (URLError, TimeoutError, OSError, ValueError):
        raise CommercialError('commercial_unavailable') from None
