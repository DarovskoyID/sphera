"""Gate module endpoints on the user's installed modules."""
from functools import wraps

from asgiref.sync import sync_to_async
from django.conf import settings
from rest_framework.permissions import BasePermission
from rest_framework.response import Response

from .models import UserModule


def enforced() -> bool:
    # Off while modules are being migrated out of the monolith: everything
    # behaves as installed. Turned on together with the «Исследовать сферу» UI.
    return getattr(settings, 'SFERA_MODULES_ENFORCE', False)


def has_module(user, module_id: str) -> bool:
    if not enforced():
        return True
    if not user or not user.is_authenticated:
        return False
    return UserModule.objects.filter(user=user, module_id=module_id).exists()


def installed_ids(user) -> set[str]:
    from .loader import discover

    present = set(discover())
    if not enforced():
        return present
    return present & set(UserModule.objects.filter(user=user).values_list('module_id', flat=True))


def requires_module(module_id: str):
    """Decorator for DRF function views: 403 unless the module is installed."""
    def deco(view):
        @wraps(view)
        def wrapped(request, *args, **kwargs):
            if not has_module(request.user, module_id):
                return Response({'error': 'module_not_installed', 'module': module_id}, status=403)
            return view(request, *args, **kwargs)
        return wrapped
    return deco


def ModuleInstalled(module_id: str):  # noqa: N802 — used like a class in permission_classes
    class _Perm(BasePermission):
        message = {'error': 'module_not_installed', 'module': module_id}

        def has_permission(self, request, view):
            return has_module(request.user, module_id)
    return _Perm


async def ws_has_module(scope, module_id: str) -> bool:
    """For channels consumers: ``if not await ws_has_module(self.scope, 'servers'): close``."""
    return await sync_to_async(has_module)(scope.get('user'), module_id)
