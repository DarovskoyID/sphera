"""Data-only commercial API bridge. Instance credentials never reach the browser."""
import json
import math
import os
import re
import uuid
import secrets
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, HTTPRedirectHandler, build_opener
from django.conf import settings

MODULE_IDS = frozenset(('amocrm', 'bitrix', 'onec', 'office', 'whiteboard', 'planner', 'conference', 'servers', 'channels', 'bots', 'diary', 'family', 'legal', 'multiserver', 'totp'))
IDENTIFIER = re.compile(r'^[a-z][a-z0-9_-]{0,63}$')
MAX_RESPONSE = 262144
CRM_IDS = frozenset(('amocrm', 'bitrix', 'onec'))


def crm_enabled():
    return bool(getattr(settings, 'SFERA_COMMERCIAL_API_URL', os.environ.get('SFERA_COMMERCIAL_API_URL', '')))


def check_local_access(user, module_id):
    """Existing node ACLs remain authoritative; they are never sent to the company."""
    if module_id not in CRM_IDS or getattr(user, 'is_superuser', False):
        return
    from django.apps import apps
    try:
        model = apps.get_model(f'sfera_{module_id}', 'Connection')
    except LookupError:
        return
    connection = model.objects.first()
    if connection and connection.allowed_users.exists() and not connection.allowed_users.filter(pk=user.id).exists():
        raise CommercialError('module_access_denied', 403)

class CommercialError(Exception):
    def __init__(self, code, status=503):
        self.code, self.status = code, status
        super().__init__(code)

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def provider_url():
    def setting(name): return getattr(settings, name, os.environ.get(name, ''))
    base = str(setting('SFERA_COMMERCIAL_API_URL')).rstrip('/')
    if not base: raise CommercialError('commercial_not_configured')
    parsed = urlparse(base)
    local = parsed.hostname in ('127.0.0.1', 'localhost', '::1')
    if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname:
        raise CommercialError('commercial_invalid_configuration')
    if parsed.scheme != 'https' and not (local and parsed.scheme == 'http'):
        raise CommercialError('commercial_invalid_configuration')
    return base


def config():
    base = provider_url()
    def setting(name): return getattr(settings, name, os.environ.get(name, ''))
    instance = str(setting('SFERA_COMMERCIAL_INSTANCE_ID'))
    token = str(setting('SFERA_COMMERCIAL_API_KEY'))
    if setting('SFERA_COMMERCIAL_CREDENTIAL_SOURCE') != 'environment':
        from .models import CommercialConnection
        from sfera_messages.encryption import decrypt_text
        stored = CommercialConnection.objects.filter(pk=1).first()
        if stored and stored.encrypted_api_key:
            if stored.provider_url != base: raise CommercialError('commercial_provider_changed')
            instance, token = str(stored.instance_id), decrypt_text(stored.encrypted_api_key)
    if not instance or not token: raise CommercialError('commercial_not_configured')
    return base, instance, token


def activate_key(user, raw, module_id=None):
    if not getattr(user, 'is_superuser', False): raise CommercialError('admin_required', 403)
    if not isinstance(raw, str) or not re.fullmatch(r'SFERA-[A-Za-z0-9_-]{43}', raw): raise CommercialError('invalid_activation', 400)
    if module_id is not None and (not isinstance(module_id, str) or module_id not in MODULE_IDS): raise CommercialError('invalid_activation', 400)
    from django.db import transaction
    from .models import CommercialConnection
    from sfera_messages.encryption import decrypt_text, encrypt_text
    base = provider_url()
    with transaction.atomic():
        stored, _ = CommercialConnection.objects.get_or_create(pk=1)
        stored = CommercialConnection.objects.select_for_update().get(pk=1)
        existing_token = ''
        if stored.encrypted_api_key:
            if stored.provider_url != base: raise CommercialError('commercial_provider_changed')
            existing_token = decrypt_text(stored.encrypted_api_key)
        else:
            instance = str(getattr(settings, 'SFERA_COMMERCIAL_INSTANCE_ID', os.environ.get('SFERA_COMMERCIAL_INSTANCE_ID', '')))
            existing_token = str(getattr(settings, 'SFERA_COMMERCIAL_API_KEY', os.environ.get('SFERA_COMMERCIAL_API_KEY', '')))
            if instance and existing_token:
                try: stored.instance_id = uuid.UUID(instance)
                except ValueError: raise CommercialError('commercial_invalid_configuration') from None
        if not stored.encrypted_claim_nonce:
            stored.encrypted_claim_nonce = encrypt_text(secrets.token_urlsafe(32))
        stored.provider_url = base
        stored.save()
    # Save the retry identity before HTTP so a lost response is recoverable.
    payload = {'license_key': raw, 'instance_id': str(stored.instance_id), 'claim_nonce': decrypt_text(stored.encrypted_claim_nonce), 'instance_name': str(getattr(settings, 'SFERA_DOMAIN', 'User node'))[:200]}
    if module_id is not None: payload['module_id'] = module_id
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if existing_token: headers['Authorization'] = 'Bearer ' + existing_token
    request = Request(base + '/v1/licenses/activate', data=json.dumps(payload).encode(), headers=headers, method='POST')
    try:
        with build_opener(NoRedirect()).open(request, timeout=15) as response:
            if response.headers.get_content_type() != 'application/json': raise CommercialError('commercial_invalid_response', 502)
            result = json.loads(response.read(8193))
        if not isinstance(result, dict) or result.get('instance_id') != str(stored.instance_id) or not isinstance(result.get('api_key'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{64}', result['api_key']):
            raise CommercialError('commercial_invalid_response', 502)
        modules = result.get('modules')
        if not isinstance(modules, list) or any(module not in MODULE_IDS for module in modules): raise CommercialError('commercial_invalid_response', 502)
    except HTTPError as error:
        upstream_code = ''
        try: upstream_code = json.loads(error.read(8192)).get('error', '')
        except (ValueError, AttributeError): pass
        if upstream_code == 'license_module_mismatch': raise CommercialError('license_module_mismatch', 403) from None
        code = 'license_already_bound' if error.code == 409 else 'license_invalid_or_expired' if error.code in (400, 401, 403) else 'commercial_unavailable'
        raise CommercialError(code, 409 if error.code == 409 else 400 if error.code in (400, 401, 403) else 503) from None
    except (OSError, URLError, ValueError, TypeError):
        raise CommercialError('commercial_unavailable') from None
    with transaction.atomic():
        current = CommercialConnection.objects.select_for_update().get(pk=1)
        if current.encrypted_claim_nonce != stored.encrypted_claim_nonce or current.instance_id != stored.instance_id:
            raise CommercialError('activation_conflict', 409)
        current.encrypted_api_key = encrypt_text(result['api_key'])
        current.save(update_fields=['encrypted_api_key', 'updated_at'])
    return {'activated': True, 'modules': modules}

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

def call(user, module_id=None, action_id=None, values=None, request_id=None):
    check_local_access(user, module_id)
    base, instance, token = config()
    path = '/v1/catalog'
    if module_id is not None:
        if module_id not in MODULE_IDS: raise CommercialError('unknown_module', 404)
        path = f'/v1/modules/{module_id}/view'
    if action_id is not None:
        if module_id is None or not IDENTIFIER.fullmatch(action_id): raise CommercialError('unknown_action', 400)
        path = f'/v1/modules/{module_id}/actions/{action_id}'
    payload = {'instance_id': instance, 'actor': str(user.id), 'actor_admin': bool(getattr(user, 'is_superuser', False))}
    if request_id is not None:
        try: payload['request_id'] = str(uuid.UUID(str(request_id)))
        except ValueError: raise CommercialError('invalid_request_id', 400) from None
    if values is not None: payload['values'] = values_checked(values)
    encoded = json.dumps(payload, allow_nan=False).encode()
    if len(encoded) > 65536: raise CommercialError('request_too_large', 413)
    request = Request(base + path, data=encoded, headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json', 'Accept': 'application/json'}, method='POST')
    try:
        with build_opener(NoRedirect()).open(request, timeout=45 if action_id and action_id != 'authorize' else 8) as response:
            if response.headers.get_content_type() != 'application/json': raise CommercialError('commercial_invalid_response', 502)
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE: raise CommercialError('commercial_invalid_response', 502)
            result = json.loads(data)
            if not isinstance(result, dict): raise CommercialError('commercial_invalid_response', 502)
            return result
    except HTTPError as error:
        safe_errors = {'admin_required': 403, 'invalid_values': 400, 'integration_not_configured': 409, 'action_outcome_unknown': 409, 'request_id_conflict': 409, 'invalid_request_id': 400, 'integration_request_failed': 502}
        try:
            code = json.loads(error.read(1024)).get('error')
            if safe_errors.get(code) == error.code:
                raise CommercialError(code, error.code) from None
        except (ValueError, AttributeError, TypeError):
            pass
        codes = {401: 'commercial_credentials_invalid', 403: 'subscription_required', 404: 'commercial_not_found', 503: 'module_migration_pending'}
        raise CommercialError(codes.get(error.code, 'commercial_unavailable'), error.code if error.code in codes else 502) from None
    except (URLError, TimeoutError, OSError, ValueError):
        raise CommercialError('commercial_unavailable') from None
