from django.http import FileResponse, HttpResponse
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from . import hooks, remote
from .purge import purge_module_data
from .loader import SDK_VERSION, discover
from .models import InstanceModule
from .permissions import can_manage, enforced, installed_ids


def _pick(manifest: dict, key: str, default):
    return manifest.get(key, default) if manifest else default


def _catalog_entry(mid: str, deployed, spec: dict | None, installed: set[str]) -> dict:
    """One card: what is loaded on this server, merged with the head of module/<id>."""
    manifest = (spec or {}).get('manifest') or {}
    job = remote.job(mid)
    on_disk = remote.disk_ref(mid)
    base = deployed.public() if deployed else {
        'id': mid,
        'version': _pick(manifest, 'version', '0.0.0'),
        'name': _pick(manifest, 'name', {}),
        'description': _pick(manifest, 'description', {}),
        'deps': _pick(manifest, 'deps', []),
        'icon': _pick(manifest, 'icon', ''),
        'provides': _pick(manifest, 'provides', []),
        'preAuth': bool(_pick(manifest, 'preAuth', False)),
    }
    base.pop('entry', None)
    latest = manifest.get('version') if manifest else None
    status = (job or {}).get('status')
    needs_sdk = int(_pick(manifest, 'sdkVersion', SDK_VERSION) or SDK_VERSION)
    return {
        **base,
        # Published for a newer core: installing it would only half-work, so the
        # card says so instead of offering a button.
        'needsCoreSdk': needs_sdk if needs_sdk > SDK_VERSION else None,
        'installed': mid in installed,
        'deployed': deployed is not None,
        'bundle': remote.bundle_url(mid) if deployed else None,
        'latestVersion': latest,
        'updateAvailable': bool(deployed and spec and on_disk and on_disk != spec['ref']),
        'pending': status if status in ('installing', 'updating', 'restarting') else None,
        'manualRestart': bool((job or {}).get('manual')),
        'error': (job or {}).get('error') if status == 'failed' else None,
    }


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def module_list(request):
    """Modules in the repository (module/<id> branches) and on this server, and which are installed."""
    deployed = discover()
    repo, repo_error = remote.catalog(force=request.query_params.get('refresh') == '1' and can_manage(request.user))
    manage = can_manage(request.user)
    installed = installed_ids() | {m for m in InstanceModule.objects.values_list('module_id', flat=True)}
    remote.auto_update(repo, deployed, installed)
    ids = sorted(set(deployed) | (set(repo) if manage else set()) | ({m for m in installed if remote.job(m)}))
    return Response({
        'enforced': enforced(),
        'can_manage': manage,
        'repo_error': repo_error if manage else None,
        'modules': [_catalog_entry(mid, deployed.get(mid), repo.get(mid), installed) for mid in ids],
    })


@api_view(['GET'])
@permission_classes([AllowAny])
def public_modules(request):
    """Installed modules whose UI also runs on the sign-in screen (manifest `preAuth`)."""
    installed = installed_ids()
    return Response({'modules': [
        {**m.public(), 'installed': True, 'deployed': True, 'bundle': remote.bundle_url(m.id)}
        for m in discover().values()
        if m.pre_auth and m.id in installed
    ]})


@api_view(['GET'])
@permission_classes([AllowAny])
def module_bundle(request, module_id):
    """Frontend of a module checked out on this server, built on first request."""
    if module_id not in discover() or not remote.has_frontend(module_id):
        return Response({'error': 'unknown_module'}, status=404)
    try:
        path = remote.build_bundle(module_id)
    except Exception as e:
        return HttpResponse(f'console.error({str(e)[:500]!r});', status=500, content_type='text/javascript')
    resp = FileResponse(open(path, 'rb'), content_type='text/javascript; charset=utf-8')
    # The URL carries the commit (?v=), so a build never changes under it.
    resp['Cache-Control'] = 'public, max-age=31536000, immutable' if request.GET.get('v') else 'no-cache'
    resp['Access-Control-Allow-Origin'] = '*'
    return resp


@api_view(['POST', 'PUT', 'DELETE'])
@permission_classes([IsAuthenticated])
def module_install(request, module_id):
    """POST installs (fetching from the repository when needed), PUT updates to the branch head, DELETE uninstalls."""
    user = request.user
    if not can_manage(user):
        return Response({'error': 'superuser_only'}, status=403)
    if not remote.ID_RE.match(module_id):
        return Response({'error': 'unknown_module'}, status=404)

    deployed = discover()
    have = set(InstanceModule.objects.values_list('module_id', flat=True))
    repo, repo_error = remote.catalog() if request.method != 'DELETE' else ({}, None)
    if request.method != 'DELETE' and module_id not in deployed and module_id not in repo:
        # The branch list may be stale or the repository unreachable, while the
        # commit of a module installed earlier is still in the local clone:
        # that is exactly the case this restores from.
        known = remote.known_spec(module_id) if module_id in have else None
        if known:
            repo = {**repo, module_id: known}
        elif repo_error:
            return Response({'error': 'repo_unavailable', 'detail': repo_error}, status=502)
        else:
            return Response({'error': 'unknown_module'}, status=404)
    if request.method == 'DELETE' and module_id not in deployed and module_id not in have:
        return Response({'error': 'unknown_module'}, status=404)
    if request.method in ('POST', 'PUT'):
        ids = remote.closure(module_id, repo)
        missing = [mid for mid in ids if mid not in deployed and mid not in repo]
        if missing:
            return Response({'error': 'missing_deps', 'modules': missing}, status=409)
        if request.method == 'PUT' and module_id not in have:
            return Response({'error': 'not_installed'}, status=409)
        too_new = [mid for mid in ids
                   if int(((repo.get(mid) or {}).get('manifest') or {}).get('sdkVersion', SDK_VERSION)) > SDK_VERSION]
        if too_new:
            # Better a refusal than a module that fetches, fails to migrate and
            # leaves the instance half-installed.
            return Response({'error': 'core_too_old', 'modules': too_new, 'sdk': SDK_VERSION}, status=409)
        for mid in ids:
            if (remote.job(mid) or {}).get('status') == 'failed':
                remote.clear_job(mid)  # retry
        jobs = remote.start(ids if request.method == 'POST' else [module_id], repo, update=request.method == 'PUT')
        to_install = [mid for mid in ids if mid not in have]
        for mid in to_install:
            InstanceModule.objects.get_or_create(module_id=mid, defaults={'installed_by': user})
            hooks.module_installed.send(sender=None, user=user, module_id=mid)
        if to_install:
            hooks.forget_installed()
        return Response({'installed': to_install if request.method == 'POST' else [], 'jobs': jobs},
                        status=202 if jobs else 200)

    # DELETE: a module may insist on staying (e.g. family while in use).
    guard = hooks.providers(hooks.CAN_UNINSTALL).get(module_id)
    reason = guard(user) if guard else None
    if reason:
        return Response({'error': 'locked', 'detail': reason}, status=409)
    # Refuse while another installed module depends on this one.
    dependants = [mid for mid in have if mid in deployed and module_id in deployed[mid].deps]
    if dependants:
        return Response({'error': 'required_by', 'modules': dependants}, status=409)
    # A failed install must not keep haunting the card; and when the code never
    # made it onto this server, nothing of the module is kept — so installing it
    # again starts from scratch instead of trusting a stale record.
    if module_id in deployed:
        remote.clear_job(module_id)
    else:
        remote.forget(module_id)
    deleted, _ = InstanceModule.objects.filter(module_id=module_id).delete()
    hooks.forget_installed()
    # Removing a module removes its data. Anything kept would come back to life
    # on the next install — and worse, its hooks keep answering until the server
    # restarts, so an uninstalled two-factor module would go on demanding codes.
    purged = purge_module_data(module_id)
    if deleted:
        hooks.module_uninstalled.send(sender=None, user=user, module_id=module_id)
    return Response({'uninstalled': bool(deleted), 'purged': purged})
