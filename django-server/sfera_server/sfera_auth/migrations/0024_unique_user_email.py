"""One account per email address.

Nothing stopped two accounts from carrying the same address before — the
registration form checked, but changing the address on a profile did not, and
the database had no say at all. Password recovery and sign-in codes are sent to
an address, so a shared one makes "whose account is this?" unanswerable.

An instance that already has duplicates cannot simply gain the constraint, so
the addresses are separated first: the account that registered earliest keeps
the address, the later ones lose it (their other data is untouched) and are
printed, because those people have to be asked for an address of their own.
Until then they sign in by password as usual and can set an address in their
profile.
"""
import django.db.models.functions.text
from django.db import migrations, models


def free_duplicate_emails(apps, schema_editor):
    User = apps.get_model('sfera_auth', 'User')
    seen: dict[str, object] = {}
    freed = []
    for user in User.objects.exclude(email='').exclude(email=None).order_by('date_joined', 'id').iterator():
        key = (user.email or '').strip().lower()
        if not key:
            continue
        if key in seen:
            freed.append((user.username, user.email, seen[key]))
            user.email = ''
            user.save(update_fields=['email'])
        else:
            seen[key] = user.username
    for username, email, kept_by in freed:
        print(f'[sfera_auth] {username}: адрес {email} освобождён (остался у {kept_by}) — попросите указать свой')


def noop(apps, schema_editor):
    """Letting go of the constraint needs nothing; the addresses stay as they are."""


class Migration(migrations.Migration):

    dependencies = [
        ("auth", "0012_alter_user_first_name_max_length"),
        ("sfera_auth", "0023_passwordresetcode"),
    ]

    operations = [
        migrations.RunPython(free_duplicate_emails, noop),
        migrations.AddConstraint(
            model_name="user",
            constraint=models.UniqueConstraint(
                django.db.models.functions.text.Lower("email"),
                condition=models.Q(("email", ""), _negated=True),
                name="uniq_user_email_ci",
            ),
        ),
    ]
