"""Materialize a fresh verified snapshot, atomically, without trusting SQL IDs.

This does not mint a login or prove message delivery. Authentication and encrypted
message transport remain separate required layers of the application runtime.
"""
import copy
from hashlib import sha256
from django.db import transaction
from sfera_mesh.storage import canonical
from sfera_mesh.application_profiles import public_profiles
from sfera_mesh.application_dialogs import validate_dialogs, conversation_id


def synchronize(directory, *, using='default'):
    from sfera_auth.models import User
    from sfera_messages.models import Conversation
    from .models import ApplicationReplica, AccountProjection, DialogProjection
    with directory.lock:
        directory.anchor()  # Refuse stale/quorum-unavailable state before SQL.
        state = copy.deepcopy(directory.current['state'])
        network, genesis = directory.network, directory.pin
    profiles = public_profiles(state, network, genesis)
    validate_dialogs(state, network, genesis)
    height = state.get('height')
    if type(height) is not int or height < 1:
        raise ValueError('application_projection_height')
    snapshot_digest = sha256(canonical(state)).hexdigest()
    with transaction.atomic(using=using):
        replica = ApplicationReplica.objects.using(using).select_for_update().filter(pk=1).first()
        if replica is not None:
            if (replica.network != network or replica.genesis != genesis or replica.height > height
                    or replica.height == height and replica.snapshot_digest != snapshot_digest):
                raise ValueError('application_projection_rollback_or_trust_change')
        else:
            replica = ApplicationReplica(id=1, network=network, genesis=genesis)
        users = {}
        for profile in profiles:
            mapping = AccountProjection.objects.using(using).select_for_update().filter(pk=profile['owner']).first()
            if mapping is None:
                # A legacy local account is never adopted merely because its
                # UUID/name happens to collide with a network identity.
                if User.objects.using(using).filter(pk=profile['id']).exists():
                    raise ValueError('application_projection_legacy_account_collision')
                user = User(id=profile['id'], username=profile['username'], nickname=profile['nickname'])
                user.set_unusable_password()
                user.save(using=using, force_insert=True)
                mapping = AccountProjection(owner=profile['owner'], user=user, version=profile['version'], digest=profile['digest'])
            else:
                if (str(mapping.user_id) != profile['id'] or mapping.version > profile['version']
                        or mapping.version == profile['version'] and mapping.digest != profile['digest']):
                    raise ValueError('application_projection_identity_conflict')
                user = User.objects.using(using).get(pk=mapping.user_id)
                # Never overwrite bans, permissions, credentials or staff role.
                user.username, user.nickname = profile['username'], profile['nickname']
                user.save(using=using, update_fields=['username','nickname'])
                mapping.version, mapping.digest = profile['version'], profile['digest']
            mapping.save(using=using)
            users[profile['owner']] = user.pk
        for identity, head in state.get('application_dialogs', {}).items():
            cid = conversation_id(identity)
            members = {users[owner] for owner in head['record']['body']['members']}
            mapping = DialogProjection.objects.using(using).select_for_update().filter(pk=identity).first()
            if mapping is None:
                if Conversation.objects.using(using).filter(pk=cid).exists():
                    raise ValueError('application_projection_legacy_dialog_collision')
                conversation = Conversation.objects.using(using).create(id=cid,cipher_only=True)
                conversation.participants.add(*members)
                DialogProjection.objects.using(using).create(identity=identity, conversation=conversation, digest=head['digest'])
            else:
                if str(mapping.conversation_id) != cid or mapping.digest != head['digest']:
                    raise ValueError('application_projection_dialog_conflict')
                if not mapping.conversation.cipher_only:
                    raise ValueError('application_projection_cipher_mode_tampered')
                actual = set(mapping.conversation.participants.using(using).values_list('pk',flat=True))
                if actual != members:
                    raise ValueError('application_projection_membership_tampered')
        # Retained network identities must not disappear from a subsequent view.
        if set(AccountProjection.objects.using(using).values_list('owner',flat=True)) != set(users):
            raise ValueError('application_projection_account_disappeared')
        if set(DialogProjection.objects.using(using).values_list('identity',flat=True)) != set(state.get('application_dialogs',{})):
            raise ValueError('application_projection_dialog_disappeared')
        replica.height, replica.snapshot_digest = height, snapshot_digest
        replica.save(using=using)
    return {'height':height, 'accounts':len(users), 'dialogs':len(state.get('application_dialogs',{}))}
