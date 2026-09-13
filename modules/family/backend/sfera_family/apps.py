from django.apps import AppConfig


class SferaFamilyConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'sfera_family'
    verbose_name = 'Family centre'

    def ready(self):
        from sfera_modules import hooks

        def is_managed(user):
            membership = getattr(user, 'family_membership', None)
            return bool(membership and membership.role == 'child')

        def can_uninstall(user):
            # Child protection must not be something a click in «Исследовать
            # сферу» can switch off; parents leave the family first.
            from .models import FamilyMembership
            if FamilyMembership.objects.filter(user=user).exists():
                return 'leave the family first'
            return None

        def has_data(user):
            from .models import FamilyMembership
            return FamilyMembership.objects.filter(user=user).exists()

        def metrics():
            from .models import Family, FamilyMembership
            return {'tables': {'families': Family.objects.count(), 'family_members': FamilyMembership.objects.count()}}

        # Deliberately not gated by requires_module: enforcement applies to every
        # account in a family regardless of what its UI has installed.
        hooks.register(hooks.IS_MANAGED, 'family', is_managed)
        hooks.register(hooks.CAN_UNINSTALL, 'family', can_uninstall)
        hooks.register(hooks.HAS_DATA, 'family', has_data)
        hooks.register(hooks.METRICS, 'family', metrics)
