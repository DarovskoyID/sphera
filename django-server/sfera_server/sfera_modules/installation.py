from .models import DisabledCommercialModule


def assert_enabled(module_id):
    from .commercial import CommercialError
    if DisabledCommercialModule.objects.filter(module_id=module_id).exists():
        raise CommercialError('module_not_installed', 403)


def annotate_catalog(result):
    disabled = set(DisabledCommercialModule.objects.values_list('module_id', flat=True))
    return {**result, 'modules': [{**row, 'installed': bool(row.get('available') and row['id'] not in disabled)} for row in result.get('modules', [])]}
