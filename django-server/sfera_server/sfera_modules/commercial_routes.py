"""Cut over CRM business endpoints without deleting their local historical data."""
from django.http import JsonResponse
from django.urls import re_path
from .commercial import crm_enabled


def route(request, module_id, legacy_path):
    if crm_enabled() and not legacy_path.startswith(('webhook/', 'events/', 'users/')):
        response = JsonResponse({'error': 'commercial_runtime_required', 'endpoint': f'/api/modules/commercial/{module_id}/view/'}, status=410)
        response['Cache-Control'] = 'no-store'
        return response
    # Retain local event history and inbound hooks during the storage migration.
    from importlib import import_module
    from django.urls import resolve, Resolver404
    try:
        urls = import_module(f'sfera_{module_id}.urls')
        matched = resolve('/' + legacy_path, urlconf=tuple(urls.urlpatterns))
    except (ModuleNotFoundError, Resolver404):
        return JsonResponse({'error': 'not_found'}, status=404)
    return matched.func(request, *matched.args, **matched.kwargs)


urlpatterns = [re_path(r'^api/(?P<module_id>amocrm|bitrix|onec)/(?P<legacy_path>.*)$', route)]
