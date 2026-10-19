"""Copy pre-module diaries (Guild.is_private) into sfera_diary tables.

The legacy guilds stay untouched here; 0003 removes them once the copy is in.
Attachment files are encrypted blobs and are re-referenced, not copied.
Owners get the module auto-installed so nothing disappears for them.
"""
from django.db import connection, migrations


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
    if 'is_private' not in {f.name for f in Guild._meta.get_fields()}:
        return False
    with connection.cursor() as c:
        tables = connection.introspection.table_names(c)
        if Guild._meta.db_table not in tables:
            return False
        cols = {col.name for col in connection.introspection.get_table_description(c, Guild._meta.db_table)}
    return 'is_private' in cols


def copy_diaries(apps, schema_editor):
    if not _legacy_available(apps):
        return
    Guild = _legacy_model(apps, 'Guild')
    GuildMessage = _legacy_model(apps, 'GuildMessage')
    GuildAttachment = _legacy_model(apps, 'GuildAttachment')
    GuildPollVote = _legacy_model(apps, 'GuildPollVote')
    GuildTodoCheck = _legacy_model(apps, 'GuildTodoCheck')
    Diary = apps.get_model('sfera_diary', 'Diary')
    DiaryEntry = apps.get_model('sfera_diary', 'DiaryEntry')
    DiaryAttachment = apps.get_model('sfera_diary', 'DiaryAttachment')
    DiaryPollVote = apps.get_model('sfera_diary', 'DiaryPollVote')
    DiaryTodoCheck = apps.get_model('sfera_diary', 'DiaryTodoCheck')
    UserModule = apps.get_model('sfera_modules', 'UserModule')

    for g in Guild.objects.filter(is_private=True).iterator():
        if Diary.objects.filter(legacy_guild_id=g.id).exists():
            continue  # idempotent
        # Keep the guild id so clients' cached references stay valid.
        diary = Diary.objects.create(id=g.id, owner_id=g.owner_id, name=g.name, legacy_guild_id=g.id)
        Diary.objects.filter(id=diary.id).update(created_at=g.created_at)
        UserModule.objects.get_or_create(user_id=g.owner_id, module_id='diary')

        for m in GuildMessage.objects.filter(channel__guild_id=g.id).order_by('created_at').iterator():
            entry = DiaryEntry.objects.create(
                id=m.id, diary_id=diary.id, author_id=m.author_id,
                encrypted_content=m.encrypted_content, tags=m.tags or [], edited=m.edited,
                message_type=m.message_type, encrypted_payload=m.encrypted_payload, live_until=m.live_until,
            )
            DiaryEntry.objects.filter(id=entry.id).update(created_at=m.created_at)
            DiaryPollVote.objects.bulk_create([
                DiaryPollVote(message_id=entry.id, user_id=v.user_id, option_id=v.option_id, created_at=v.created_at)
                for v in GuildPollVote.objects.filter(message_id=m.id)
            ])
            DiaryTodoCheck.objects.bulk_create([
                DiaryTodoCheck(message_id=entry.id, user_id=c.user_id, item_id=c.item_id, created_at=c.created_at)
                for c in GuildTodoCheck.objects.filter(message_id=m.id)
            ])

        for a in GuildAttachment.objects.filter(channel__guild_id=g.id).iterator():
            DiaryAttachment.objects.create(
                id=a.id, diary_id=diary.id, entry_id=a.message_id, uploader_id=a.uploader_id,
                file=a.file.name, original_filename=a.original_filename,
                content_type=a.content_type, file_size=a.file_size,
            )


class Migration(migrations.Migration):
    run_before = [('sfera_messages', '0023_move_guilds_to_servers_module')]

    dependencies = [
        ('sfera_diary', '0001_initial'),
        ('sfera_messages', '0022_message_edited'),
        ('sfera_modules', '0001_initial'),
    ]

    operations = [
        migrations.RunPython(copy_diaries, migrations.RunPython.noop),
    ]
