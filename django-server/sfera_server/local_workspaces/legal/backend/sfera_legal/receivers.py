def export(user):
    from .models import Package, Signature

    return {
        'legal_protocols': [
            {'code': p.code, 'title': p.title, 'status': p.status, 'hash': p.content_hash,
             'messages': p.message_count, 'created_at': p.created_at.isoformat(),
             'sealed_at': p.sealed_at.isoformat() if p.sealed_at else None}
            for p in Package.objects.filter(owner=user).iterator()
        ],
        'legal_signatures': [
            {'protocol': s.package.code, 'signed_at': s.signed_at.isoformat(), 'method': s.method,
             'hash': s.signed_hash}
            for s in Signature.objects.filter(user=user).select_related('package').iterator()
        ],
    }


def metrics():
    """Protocols, signatures and how far the hash chain reaches."""
    from sfera_modules.hooks import approx_count
    from sfera_server.metrics import _cval

    from .models import ChainEntry, LegalSettings, Package, Signature

    settings_row = LegalSettings.load()
    sealed = Package.objects.filter(status=Package.STATUS_SEALED).count()
    broken = Package.objects.filter(chain_ok=False).count()
    return {
        'tables': {
            'legal_protocols': approx_count(Package),
            'legal_signatures': approx_count(Signature),
            'legal_chain_links': approx_count(ChainEntry),
        },
        'prometheus': [
            {'name': 'sfera_legal_recording', 'type': 'gauge', 'value': 1 if settings_row.record_chain else 0,
             'help': '1 when the hash chain of conversations is being written'},
            {'name': 'sfera_legal_protocols_sealed', 'type': 'gauge', 'value': sealed,
             'help': 'Protocols frozen and hashed'},
            {'name': 'sfera_legal_protocols_broken_chain', 'type': 'gauge', 'value': broken,
             'help': 'Protocols whose chain did not add up'},
            {'name': 'sfera_legal_chain_links_total', 'type': 'counter', 'value': _cval('legal_chain_links'),
             'help': 'Messages written into the chain'},
            {'name': 'sfera_legal_chain_dropped_total', 'type': 'counter', 'value': _cval('legal_chain_dropped'),
             'help': 'Links lost because the queue was full'},
            {'name': 'sfera_legal_packages_sealed_total', 'type': 'counter', 'value': _cval('legal_packages_sealed'),
             'help': 'Seal operations'},
            {'name': 'sfera_legal_signatures_total', 'type': 'counter', 'value': _cval('legal_signatures'),
             'help': 'Signatures placed under protocols'},
        ],
        'status': {'Фиксация переписки': {
            'Запись цепочки': 'включена' if settings_row.record_chain else 'выключена',
            'Протоколов закреплено': sealed,
        }},
    }


def has_data(user):
    from .models import Package

    return Package.objects.filter(owner=user).exists()


def encrypted_data():
    from .models import Package, Signature

    return {'files': [Package, Signature]}
