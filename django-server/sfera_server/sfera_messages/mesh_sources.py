"""Explicit message namespaces; a guild UUID can never select a DM source."""
from django.apps import apps


def source_name(message):
    label = message._meta.label_lower
    if label == 'sfera_messages.message':
        return 'dm'
    if label == 'sfera_servers.guildmessage':
        return 'guild'
    raise ValueError('unsupported_mesh_message_source')


def source_model(source):
    labels = {'dm': 'sfera_messages.Message', 'guild': 'sfera_servers.GuildMessage'}
    if source not in labels:
        raise ValueError('unsupported_mesh_message_source')
    try:
        return apps.get_model(labels[source])
    except LookupError as exc:
        raise ValueError('mesh_message_module_unavailable') from exc


def scope_field(source):
    return 'conversation_id' if source == 'dm' else 'channel_id'


def scope_id(message):
    return getattr(message, scope_field(source_name(message)))


def source_current(write):
    return source_model(write.source).objects.using(write._state.db).filter(
        pk=write.message_id, **{scope_field(write.source): write.conversation_id})
