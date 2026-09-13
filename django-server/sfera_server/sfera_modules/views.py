from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from . import hooks
from .loader import discover
from .models import UserModule
from .permissions import enforced, installed_ids


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def module_list(request):
    """Catalog of modules available on this instance + which ones the user has."""
    installed = installed_ids(request.user)
    return Response({
        'enforced': enforced(),
        'modules': [
            {**m.public(), 'installed': m.id in installed}
            for m in discover().values()
        ],
    })


@api_view(['POST', 'DELETE'])
@permission_classes([IsAuthenticated])
def module_install(request, module_id):
    catalog = discover()
    manifest = catalog.get(module_id)
    if manifest is None:
        return Response({'error': 'unknown_module'}, status=404)

    user = request.user
    if request.method == 'POST':
        have = set(UserModule.objects.filter(user=user).values_list('module_id', flat=True))
        # Install missing dependencies along with the module.
        to_install, stack = [], [module_id]
        while stack:
            mid = stack.pop()
            if mid in have or mid in to_install:
                continue
            to_install.append(mid)
            stack.extend(catalog[mid].deps)
        for mid in to_install:
            UserModule.objects.get_or_create(user=user, module_id=mid)
            hooks.module_installed.send(sender=None, user=user, module_id=mid)
        return Response({'installed': to_install})

    # DELETE: a module may insist on staying (e.g. family for a managed account).
    guard = hooks.providers(hooks.CAN_UNINSTALL).get(module_id)
    reason = guard(user) if guard else None
    if reason:
        return Response({'error': 'locked', 'detail': reason}, status=409)
    # Refuse while another installed module depends on this one.
    have = set(UserModule.objects.filter(user=user).values_list('module_id', flat=True))
    dependants = [mid for mid in have if mid in catalog and module_id in catalog[mid].deps]
    if dependants:
        return Response({'error': 'required_by', 'modules': dependants}, status=409)
    deleted, _ = UserModule.objects.filter(user=user, module_id=module_id).delete()
    if deleted:
        hooks.module_uninstalled.send(sender=None, user=user, module_id=module_id)
    return Response({'uninstalled': bool(deleted)})
