"""Copy pre-module personal channels (Guild.is_personal_channel) into sfera_channels.

Ids are kept (channel = guild id, post = message id) so links and cached client
state stay valid. Attachment files are re-referenced, not copied. Every member
gets the module auto-installed. Legacy rows are removed in 0004.
"""
from django.db import connection, migrations

BATCH = 1000


def _legacy_model(apps, name):
    """Guild models live in sfera_messages historically and in sfera_servers after the move."""
    for app in ('sfera_messages', 'sfera_servers'):
        try:
            return apps.get_model(app, name)
        except LookupError:
            continue
    raise LookupError(name)


def _legacy_available(apps):
    try:
        Guild = _legacy_model(apps, 'Guild')
    except LookupError:
        return False
    if 'is_personal_channel' not in {f.name for f in Guild._meta.get_fields()}:
        return False
    with connection.cursor() as c:
        if Guild._meta.db_table not in connection.introspection.table_names(c):
            return False
        cols = {col.name for col in connection.introspection.get_table_description(c, Guild._meta.db_table)}
    return 'is_personal_channel' in cols


def _bulk(model, rows):
    for i in range(0, len(rows), BATCH):
        model.objects.bulk_create(rows[i:i + BATCH], ignore_conflicts=True)


def copy_channels(apps, schema_editor):
    if not _legacy_available(apps):
        return
    from sfera_channels import search
    from sfera_messages.encryption import decrypt_text

    M = lambda name: _legacy_model(apps, name)  # noqa: E731
    C = lambda name: apps.get_model('sfera_channels', name)  # noqa: E731
    UserModule = apps.get_model('sfera_modules', 'UserModule')
    # Keep original timestamps: auto_now_add would stamp every copied row "now".
    patched = [f for model in apps.get_app_config('sfera_channels').get_models()
               for f in model._meta.fields if getattr(f, 'auto_now_add', False)]
    for f in patched:
        f.auto_now_add = False
    try:
        _copy(apps, M, C, UserModule, search, decrypt_text)
    finally:
        for f in patched:
            f.auto_now_add = True


def _copy(apps, M, C, UserModule, search, decrypt_text):

    legacy = M('Guild').objects.filter(is_personal_channel=True)
    if 'is_private' in {f.name for f in M('Guild')._meta.get_fields()}:
        legacy = legacy.filter(is_private=False)

    for g in legacy.iterator():
        if C('Channel').objects.filter(legacy_guild_id=g.id).exists():
            continue
        C('Channel').objects.create(
            id=g.id, owner_id=g.owner_id, name=g.name, description=g.description, tags=g.tags or [],
            icon=g.icon.name if g.icon else None, banner=g.banner.name if g.banner else None,
            invite_code=g.invite_code, is_discoverable=g.is_discoverable, comments_enabled=g.comments_enabled,
            is_official=g.is_official, legacy_guild_id=g.id, created_at=g.created_at,
        )

        members = list(M('GuildMembership').objects.filter(guild_id=g.id))
        _bulk(C('Subscription'), [C('Subscription')(
            channel_id=g.id, user_id=m.user_id, notifications_muted=m.notifications_muted, joined_at=m.joined_at,
            role='owner' if m.user_id == g.owner_id else 'subscriber',
        ) for m in members])
        if not any(m.user_id == g.owner_id for m in members):
            C('Subscription').objects.get_or_create(channel_id=g.id, user_id=g.owner_id, defaults={'role': 'owner'})
        _bulk(UserModule, [UserModule(user_id=uid, module_id='channels')
                           for uid in {m.user_id for m in members} | {g.owner_id}])

        msgs = list(M('GuildMessage').objects.filter(channel__guild_id=g.id))
        _bulk(C('Post'), [C('Post')(
            id=m.id, channel_id=g.id, author_id=m.author_id, encrypted_content=m.encrypted_content,
            tags=m.tags or [], is_pinned=m.is_pinned, edited=m.edited, message_type=m.message_type,
            encrypted_payload=m.encrypted_payload, live_until=m.live_until, created_at=m.created_at,
        ) for m in msgs])
        msg_ids = [m.id for m in msgs]

        _bulk(C('PostAttachment'), [C('PostAttachment')(
            id=a.id, channel_id=g.id, post_id=a.message_id, uploader_id=a.uploader_id, file=a.file.name,
            original_filename=a.original_filename, content_type=a.content_type, file_size=a.file_size,
            created_at=a.created_at,
        ) for a in M('GuildAttachment').objects.filter(channel__guild_id=g.id)])
        _bulk(C('PostReaction'), [C('PostReaction')(post_id=r.message_id, user_id=r.user_id, emoji=r.emoji, created_at=r.created_at)
                                  for r in M('GuildMessageReaction').objects.filter(message_id__in=msg_ids)])
        _bulk(C('PostView'), [C('PostView')(post_id=v.message_id, user_id=v.user_id, created_at=v.created_at)
                              for v in M('GuildMessageView').objects.filter(message_id__in=msg_ids)])
        _bulk(C('PostComment'), [C('PostComment')(id=c.id, post_id=c.message_id, author_id=c.author_id,
                                                  encrypted_content=c.encrypted_content, created_at=c.created_at)
                                 for c in M('GuildPostComment').objects.filter(message_id__in=msg_ids)])
        _bulk(C('PostPollVote'), [C('PostPollVote')(message_id=v.message_id, user_id=v.user_id, option_id=v.option_id,
                                                    created_at=v.created_at)
                                  for v in M('GuildPollVote').objects.filter(message_id__in=msg_ids)])
        _bulk(C('PostTodoCheck'), [C('PostTodoCheck')(message_id=t.message_id, item_id=t.item_id, user_id=t.user_id,
                                                      created_at=t.created_at)
                                   for t in M('GuildTodoCheck').objects.filter(message_id__in=msg_ids)])
        _bulk(C('ScheduledPost'), [C('ScheduledPost')(
            id=s.id, channel_id=g.id, author_id=s.author_id, encrypted_content=s.encrypted_content,
            attachment_ids=s.attachment_ids or [], send_at=s.send_at,
        ) for s in M('GuildScheduledMessage').objects.filter(channel__guild_id=g.id, is_sent=False)])

        if g.is_discoverable:
            for m in msgs:
                try:
                    search.index_raw(m.id, g.id, decrypt_text(m.encrypted_content) or '', m.tags)
                except Exception:
                    pass


class Migration(migrations.Migration):
    run_before = [('sfera_messages', '0023_move_guilds_to_servers_module')]

    dependencies = [
        ('sfera_channels', '0002_post_fts'),
        ('sfera_messages', '0022_message_edited'),
        ('sfera_modules', '0001_initial'),
    ]

    operations = [
        migrations.RunPython(copy_channels, migrations.RunPython.noop),
    ]
