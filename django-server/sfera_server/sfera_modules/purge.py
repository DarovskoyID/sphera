"""Erasing what a module stored on this instance.

Removing a module removes its data: that is what people expect of a delete
button, and keeping the rows around quietly re-animates the module the moment
it is installed again (an authenticator that still guards sign-in, a protocol
that still exists). The module's own hook runs first — it knows about caches
and files the models do not mention — and then every table of its Django app
is emptied.

The schema stays: migrations are not reversed, so a re-install starts with the
same, empty tables.
"""
import logging

from django.apps import apps as django_apps
from django.db import models, transaction

from . import hooks
from .loader import discover

logger = logging.getLogger('sfera.modules')

#: FK chains inside one app can need a couple of passes before everything goes.
MAX_PASSES = 4
FILE_CHUNK = 200


def _file_fields(model) -> list[str]:
    return [f.name for f in model._meta.get_fields()
            if isinstance(f, models.FileField)]


def _drop_files(model) -> int:
    """Delete the files behind FileFields; row deletion does not touch them."""
    fields = _file_fields(model)
    if not fields:
        return 0
    dropped = 0
    for obj in model.objects.only('pk', *fields).iterator(chunk_size=FILE_CHUNK):
        for name in fields:
            handle = getattr(obj, name, None)
            if not handle:
                continue
            try:
                handle.delete(save=False)
                dropped += 1
            except Exception:  # noqa: BLE001 — a missing file must not stop the purge
                logger.warning('purge %s: file of %s#%s stayed', model.__name__, name, obj.pk)
    return dropped


def purge_module_data(module_id: str) -> dict:
    """Empty everything the module owns. Returns what was removed."""
    report = {'rows': 0, 'files': 0, 'tables': 0, 'failed': []}

    # The module first: caches, counters, files it keeps outside its models.
    hooks.collect(hooks.PURGE_DATA, only={module_id})

    manifest = discover().get(module_id)
    app_name = getattr(manifest, 'backend_app', None)
    if not app_name:
        return report
    try:
        config = django_apps.get_app_config(app_name.rsplit('.', 1)[-1])
    except LookupError:
        # The app is on disk but this process never loaded it (a failed
        # install): there is nothing of it in memory to empty.
        return report

    pending = list(config.get_models())
    for _ in range(MAX_PASSES):
        failed = []
        # Reverse declaration order clears children before their parents, which
        # is the common case; whatever a foreign key still holds goes next pass.
        for model in reversed(pending):
            try:
                with transaction.atomic():
                    files = _drop_files(model)
                    deleted, _ = model.objects.all().delete()
                report['files'] += files
                report['rows'] += deleted
                report['tables'] += 1
            except Exception as e:  # noqa: BLE001 — one stubborn table is not the end
                failed.append(model)
                logger.info('purge %s: %s not yet (%s)', module_id, model.__name__, e)
        pending = failed
        if not pending:
            break
    report['failed'] = [m.__name__ for m in pending]
    if report['failed']:
        logger.warning('purge %s: left behind %s', module_id, ', '.join(report['failed']))
    return report
