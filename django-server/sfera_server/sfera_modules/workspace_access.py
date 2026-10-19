"""Paid control plane; content, ownership and mandatory security stay local."""
import json
from types import SimpleNamespace
from django.conf import settings
from django.http import JsonResponse
from .local_workspaces import manifests
from .commercial import call, CommercialError

SAFE_SECURITY = {'status', 'setup', 'confirm', 'disable', 'backup_codes', 'reset_user'}


def enforced():
    return getattr(settings, 'SFERA_LICENSE_ENFORCE', not settings.DEBUG)


def require(module_id, operation, *, method='MUTATE', transport='engine', values=None, user=None):
    if not enforced(): return
    from .installation import assert_enabled
    assert_enabled(module_id)
    actor = user or SimpleNamespace(id='node', is_superuser=False)
    data = {'operation': operation, 'method': method, 'transport': transport}
    if values: data.update(values)
    result = call(actor, module_id=module_id, action_id='authorize', values=data)
    if result.get('authorized') is not True or result.get('module') != module_id or result.get('operation') != operation:
        raise CommercialError('commercial_invalid_response', 502)


class WorkspaceLicenseMiddleware:
    def __init__(self, get_response): self.get_response = get_response
    def __call__(self, request): return self.get_response(request)
    def process_view(self, request, view_func, view_args, view_kwargs):
        parts = request.path.strip('/').split('/')
        if not enforced() or len(parts) < 2 or parts[0] != 'api': return None
        module_id = None
        for mid, (_, manifest) in manifests().items():
            # The legacy communities manifest mounts at api/; matching that
            # prefix would accidentally put personal messages/login behind a key.
            prefixes = ('/api/guilds/', '/api/guild-attachments/') if mid == 'servers' else (('/' + manifest['urlPrefix'],) if manifest.get('urlPrefix') else ())
            if request.path.startswith(prefixes):
                module_id = mid
                break
        if module_id is None: return None
        # Owners retain local read/export/deletion, even without the company.
        if request.method in ('GET', 'HEAD', 'OPTIONS', 'DELETE'): return None
        operation = getattr(view_func, '__name__', 'operation')
        # Already installed 2FA must remain usable and recoverable when a key expires.
        if module_id == 'totp' and operation in SAFE_SECURITY: return None
        if module_id == 'conference' and operation == 'conference_end': return None
        metadata = {}
        if request.content_type == 'application/json':
            try:
                body = json.loads(request.body)
                if isinstance(body, dict):
                    for key in ('kind', 'role', 'recurrence', 'priority'):
                        if key in body and isinstance(body[key], (str, int, bool)):
                            metadata[key] = body[key]
            except (ValueError, UnicodeDecodeError): pass
        try:
            require(module_id, operation, method=request.method, transport='http', values=metadata)
        except CommercialError as error:
            response = JsonResponse({'error': error.code, 'module': module_id}, status=error.status)
            response['Cache-Control'] = 'no-store'
            return response
        return None
