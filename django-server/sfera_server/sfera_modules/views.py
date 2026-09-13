from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from . import hooks
from .loader import discover
from .models import InstanceModule
from .permissions import can_manage, enforced, installed_ids


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def module_list(request):
    """Catalog of modules deployed on this instance + which ones are installed."""
    installed = installed_ids()
    return Response({
        'enforced': enforced(),
        'can_manage': can_manage(request.user),
        'modules': [
            {**m.public(), 'installed': m.id in installed}
            for m in discover().values()
        ],
    })


@api_view(['POST', 'DELETE'])
@permission_classes([IsAuthenticated])
def module_install(request, module_id):
    user = request.user
    if not can_manage(user):
        return Response({'error': 'superuser_only'}, status=403)

    catalog = discover()
    manifest = catalog.get(module_id)
    if manifest is None:
        return Response({'error': 'unknown_module'}, status=404)

    have = set(InstanceModule.objects.values_list('module_id', flat=True))
    if request.method == 'POST':
        # Install missing dependencies along with the module.
        to_install, stack = [], [module_id]
        while stack:
            mid = stack.pop()
            if mid in have or mid in to_install:
                continue
            to_install.append(mid)
            stack.extend(catalog[mid].deps)
        for mid in to_install:
            InstanceModule.objects.get_or_create(module_id=mid, defaults={'installed_by': user})
            hooks.module_installed.send(sender=None, user=user, module_id=mid)
        return Response({'installed': to_install})

    # DELETE: a module may insist on staying (e.g. family while in use).
    guard = hooks.providers(hooks.CAN_UNINSTALL).get(module_id)
    reason = guard(user) if guard else None
    if reason:
        return Response({'error': 'locked', 'detail': reason}, status=409)
    # Refuse while another installed module depends on this one.
    dependants = [mid for mid in have if mid in catalog and module_id in catalog[mid].deps]
    if dependants:
        return Response({'error': 'required_by', 'modules': dependants}, status=409)
    deleted, _ = InstanceModule.objects.filter(module_id=module_id).delete()
    if deleted:
        hooks.module_uninstalled.send(sender=None, user=user, module_id=module_id)
    return Response({'uninstalled': bool(deleted)})
