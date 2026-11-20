"""Seven distinct durable SQL replicas; no shared application database."""
import copy
from hashlib import sha256
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'django-server/sfera_server'))
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from django.conf import settings
from sfera_mesh.storage import canonical
from sfera_mesh.application_profiles import application_user_id
from sfera_mesh.application_dialogs import dialog_id,conversation_id

with tempfile.TemporaryDirectory(prefix='sphere-seven-application-') as folder:
    aliases=['default']+['entry'+str(i) for i in range(1,7)]
    settings.configure(SECRET_KEY='isolated-projection-test-only',USE_TZ=True,
        INSTALLED_APPS=['django.contrib.auth','django.contrib.contenttypes','sfera_auth','sfera_messages','sfera_distribution'],
        AUTH_USER_MODEL='sfera_auth.User',MESSAGE_ENCRYPTION_KEY=Fernet.generate_key().decode(),
        DATABASES={alias:{'ENGINE':'django.db.backends.sqlite3','NAME':str(Path(folder)/(alias+'.sqlite'))} for alias in aliases})
    import django
    django.setup()
    from django.apps import apps
    from django.db import connections,IntegrityError
    from sfera_auth.models import User
    from sfera_messages.models import Conversation
    from sfera_distribution.models import AccountProjection,ApplicationReplica,DialogProjection
    from sfera_distribution.projection import synchronize
    for alias in aliases:
        with connections[alias].schema_editor() as schema:
            for app in ('contenttypes','auth','sfera_auth','sfera_messages','sfera_distribution'):
                for model in apps.get_app_config(app).get_models():schema.create_model(model)
    state={'height':10,'accounts':{},'application_profiles':{},'application_dialogs':{}}
    keys={};genesis='a'*64
    for index,name in enumerate(('alice','bob'),1):
        key=Ed25519PrivateKey.from_private_bytes(bytes([index])*32);public=key.public_key().public_bytes_raw().hex()
        owner=sha256(b'sfera-mesh-user-v1\0'+bytes.fromhex(public)).hexdigest();keys[owner]=key
        state['accounts'][owner]={'record':{'body':{'public_key':public}}}
        b={'domain':'sfera-mesh-application-profile-v1','network':'lab','genesis':genesis,'owner':owner,'control_epoch':0,
            'version':1,'previous':'0'*64,'handle':name,'nickname_utf8':name.encode().hex()}
        r={'body':b,'signature':key.sign(canonical(b)).hex()}
        state['application_profiles'][owner]=[{'record':r,'digest':sha256(canonical(r)).hexdigest()}]
    members=sorted(keys);creator=members[0]
    b={'domain':'sfera-mesh-application-dialog-v1','network':'lab','genesis':genesis,'creator':creator,'control_epoch':0,'members':members}
    r={'body':b,'signature':keys[creator].sign(canonical(b)).hex()};identity=dialog_id('lab',members)
    state['application_dialogs'][identity]={'record':r,'digest':sha256(canonical(r)).hexdigest()}
    directory=SimpleNamespace(lock=threading.RLock(),network='lab',pin=genesis,current={'state':state},anchor=lambda:None)
    for alias in aliases:
        result=synchronize(directory,using=alias);assert result=={'height':10,'accounts':2,'dialogs':1}
        assert str(Conversation.objects.using(alias).get().pk)==conversation_id(identity)
        assert Conversation.objects.using(alias).get().cipher_only
        assert set(map(str,Conversation.objects.using(alias).get().participants.values_list('pk',flat=True)))=={application_user_id('lab',owner) for owner in members}
        assert all(not user.has_usable_password() for user in User.objects.using(alias).all())
        synchronize(directory,using=alias)
    # Account state remains local only where it represents an explicit local
    # guard; importing public names cannot silently restore blocked access.
    user=User.objects.using('entry1').first();user.is_active=False;user.save(using='entry1',update_fields=['is_active'])
    synchronize(directory,using='entry1');assert not User.objects.using('entry1').get(pk=user.pk).is_active
    # Reopening database connections retains the same durable projection.
    for connection in connections.all():connection.close()
    synchronize(directory,using='entry6');assert User.objects.using('entry6').count()==2
    before=ApplicationReplica.objects.get().height
    state['height']=9
    try:synchronize(directory);raise AssertionError('rollback accepted')
    except ValueError:pass
    assert ApplicationReplica.objects.get().height==before;state['height']=10
    conversation=Conversation.objects.using('entry2').get();conversation.participants.remove(User.objects.using('entry2').first())
    try:synchronize(directory,using='entry2');raise AssertionError('SQL membership tampering accepted')
    except ValueError:pass
    # A caller-controlled legacy UUID is not evidence of network ownership.
    AccountProjection.objects.using('entry3').all().delete();DialogProjection.objects.using('entry3').all().delete()
    try:synchronize(directory,using='entry3');raise AssertionError('legacy accounts adopted')
    except ValueError:pass
    directory.anchor=lambda:(_ for _ in ()).throw(ValueError('quorum unavailable'))
    try:synchronize(directory,using='entry4');raise AssertionError('unavailable quorum ignored')
    except ValueError:pass
    for connection in connections.all():connection.close()
    print('Seven independent SQL replicas: stable users/dialogs, restart, password isolation, rollback, membership tampering, legacy collision and quorum refusal passed')
