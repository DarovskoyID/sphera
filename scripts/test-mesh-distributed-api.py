"""Isolated real JWT/DRF/Channels adapters; never opens an installed database."""
import asyncio
import base64
from datetime import timedelta
import copy
from hashlib import sha256
import json
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'django-server/sfera_server'))
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from django.conf import settings


with tempfile.TemporaryDirectory(prefix='distributed-app-api-') as tmp:
    settings.configure(SECRET_KEY='isolated-distributed-api-test-only-long-key',USE_TZ=True,SFERA_DISTRIBUTED_APPLICATION=True,
        SFERA_MODULES_FROM_REPO=False,SFERA_MODULES_ENFORCE=True,
        INSTALLED_APPS=['django.contrib.auth','django.contrib.contenttypes','sfera_auth','sfera_messages','sfera_modules','sfera_distribution','rest_framework_simplejwt.token_blacklist'],
        AUTH_USER_MODEL='sfera_auth.User',MESSAGE_ENCRYPTION_KEY=Fernet.generate_key().decode(),
        DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':str(Path(tmp)/'application.sqlite')}},
        ROOT_URLCONF='sfera_distribution.urls',REST_FRAMEWORK={'DEFAULT_AUTHENTICATION_CLASSES':['sfera_auth.mesh_sessions.MeshJWTAuthentication'],'DEFAULT_THROTTLE_RATES':{'anon':'1000/min','user':'1000/min','auth':'1000/min'}},
        REFRESH_COOKIE_NAME='refresh',REFRESH_COOKIE_PATH='/api/auth/',REFRESH_COOKIE_SECURE=True,REFRESH_COOKIE_SAMESITE='Lax',
        APP_USER_AGENT_TOKEN='SphereIsolatedTest',APP_REFRESH_TOKEN_LIFETIME=timedelta(hours=24),
        SIMPLE_JWT={'ACCESS_TOKEN_LIFETIME':timedelta(minutes=15),'REFRESH_TOKEN_LIFETIME':timedelta(hours=24),
            'ROTATE_REFRESH_TOKENS':True,'BLACKLIST_AFTER_ROTATION':True},
        CHANNEL_LAYERS={'default':{'BACKEND':'channels.layers.InMemoryChannelLayer'}})
    import django
    django.setup()
    from django.core.management import call_command
    from django.db import connections
    call_command('migrate',verbosity=0,interactive=False)
    from rest_framework.test import APIRequestFactory
    from rest_framework_simplejwt.tokens import AccessToken
    from sfera_mesh.test_application_sessions import Directory
    from sfera_mesh.distributed_sessions import DistributedApplicationSessions
    from sfera_mesh.application_signals import verify_signal
    from sfera_mesh.application_profiles import application_user_id
    from sfera_mesh.identity import node_id
    from sfera_mesh.storage import canonical
    from sfera_auth import mesh_sessions,mesh_views
    from sfera_auth.models import User
    from sfera_messages.models import Conversation
    from sfera_distribution import runtime,views
    from sfera_distribution.projection import synchronize
    from sfera_signaling.consumers import SignalingConsumer
    fixture=json.loads(Path('mesh-consensus/testdata/application-dialog-v1.json').read_text())
    owner=Ed25519PrivateKey.from_private_bytes(bytes([1])*32);device=Ed25519PrivateKey.from_private_bytes(bytes([9])*32)
    class FreshDirectory(Directory):
        def anchor(self):return {'expires_at':int(time.time())+30}
        def device_history(self,identity):
            result=super().device_history(identity);result['finality']['expires_at']=int(time.time())+30;return result
    directory=FreshDirectory(owner);state=copy.deepcopy(fixture['state']);state['application_dialogs']={}
    directory.current={'state':state};directory.events=[head['event'] for head in state['devices'][fixture['creator']]]
    entry_key=Ed25519PrivateKey.generate();entry=node_id(entry_key.public_key().public_bytes_raw())
    backend=DistributedApplicationSessions(str(Path(tmp)/'sessions.sqlite'),directory,entry,entry_key=entry_key)
    factory=APIRequestFactory();sent=[]
    def request(view,data=None,token=None,method='post'):
        headers={'HTTP_AUTHORIZATION':'Bearer '+token} if token else {}
        req=getattr(factory,method)('/api/distribution/',data,format='json',**headers)
        return view(req)
    try:
        synchronize(directory)
        with patch.object(mesh_sessions,'sessions',return_value=backend),patch.object(mesh_views,'sessions',return_value=backend),patch.object(runtime,'sessions',return_value=backend),patch.object(views,'submit_account_record',side_effect=sent.append):
            challenge=request(mesh_views.login_challenge,{'owner':fixture['creator'],'device':fixture['device']})
            assert challenge.status_code==200,challenge.data
            body=challenge.data
            response=request(mesh_views.login,{'challenge':body['challenge'],'owner_signature':'','device_signature':device.sign(canonical(body)).hex()})
            assert response.status_code==200,response.data
            token=response.data['access'];access=AccessToken(token);assert access['distributed_application'] is True
            assert access['user_id']==application_user_id('lab',fixture['creator'])
            # Legacy browser rows may share an IP. A mesh login must identify
            # the signed device, never use get_or_create(user, ip) ambiguously.
            from sfera_auth.models import UserDevice
            user=User.objects.get(pk=access['user_id'])
            for suffix in ('legacy-one','legacy-two'):
                UserDevice.objects.create(user=user,device_id=suffix,ip_address='127.0.0.1',device_name=suffix,device_type='desktop')
            again=request(mesh_views.login_challenge,{'owner':fixture['creator'],'device':fixture['device']})
            second=request(mesh_views.login,{'challenge':again.data['challenge'],'owner_signature':'','device_signature':device.sign(canonical(again.data)).hex()})
            assert second.status_code==200,second.data
            assert UserDevice.objects.filter(user=user,device_id='mesh:'+fixture['device']).count()==1
            from sfera_auth import views as auth_views
            with patch.object(auth_views.me.cls,'authentication_classes',[mesh_sessions.MeshJWTAuthentication]):
                me=request(auth_views.me,token=token,method='get')
                assert me.status_code==200 and str(me.data['id'])==access['user_id'],me.data
            from django.urls import resolve
            current=resolve('/api/auth/me/',urlconf='sfera_distribution.service_urls').func
            me=request(current,token=token,method='get')
            assert me.status_code==200 and me.data['service_capabilities']['legacy_account_bootstrap'] is False,me.data
            modules=resolve('/api/modules/',urlconf='sfera_distribution.service_urls').func
            assert request(modules,method='get').status_code==401
            module_response=request(modules,token=token,method='get')
            assert module_response.status_code==200 and isinstance(module_response.data['modules'],list),module_response.data
            assert module_response.data['can_manage'] is False
            public=resolve('/api/modules/public/',urlconf='sfera_distribution.service_urls').func
            assert request(public,method='get').status_code==200
            search=resolve('/api/auth/users/',urlconf='sfera_distribution.service_urls').func
            assert request(search,method='get').status_code==401
            legacy=User.objects.create(username='not_a_network_identity')
            found=request(search,token=token,method='get')
            assert found.status_code==200 and len(found.data)==1,found.data
            assert all(str(row['id']) not in (str(legacy.pk),str(user.pk)) for row in found.data)
            update=resolve('/api/auth/me/update/',urlconf='sfera_distribution.service_urls').func
            assert request(update,{'status':'online'},method='patch').status_code==401
            for invalid in ({'status':'invalid'},{'status':'online','nickname':'unauthorized-profile-change'},{'status':['online']}):
                assert request(update,invalid,token,method='patch').status_code==400
            changed=request(update,{'status':'online'},token,method='patch')
            assert changed.status_code==200 and changed.data=={'status':'online','scope':'entry'},changed.data
            synchronize(directory)
            assert request(current,token=token,method='get').data['status']=='online'
            catalog=request(views.catalog,method='get');assert catalog.status_code==200 and len(catalog.data['profiles'])==2
            record=json.loads(Path('output/mesh-application-20261119/device-dialog-client-fixture.json').read_text())
            assert request(views.dialog,{'record':record}).status_code==401
            result=request(views.dialog,{'record':record},token);assert result.status_code==202,result.data
            assert Conversation.objects.count()==0,'pending metadata prematurely created SQL conversation'
            identity=result.data['identity'];state['application_dialogs'][identity]={'record':record,'digest':sha256(canonical(record)).hexdigest()};state['height']+=1
            synchronize(directory)
            assert Conversation.objects.get().cipher_only
            assert request(views.dialog,{'record':record},token).status_code==200
            assert len(sent)==1
            plain=AccessToken.for_user(User.objects.get(pk=access['user_id']))
            assert request(views.dialog,{'record':record},str(plain)).status_code==401,'legacy JWT bypassed mesh session'
            root_record=fixture['state']['application_dialogs'][identity]['record']
            assert request(views.dialog,{'record':root_record},token).status_code==409,'normal device route accepted owner-root format'
            profile=copy.deepcopy(state['application_profiles'][fixture['creator']][-1]['record']);profile['body'].update(version=2,previous=state['application_profiles'][fixture['creator']][-1]['digest'],nickname_utf8='new-name'.encode().hex());profile['signature']=owner.sign(canonical(profile['body'])).hex()
            assert request(views.profile,{'record':profile}).status_code==202
            assert User.objects.get(pk=access['user_id']).nickname=='alice','pending profile changed SQL identity'
            # SDK commands are additionally bound to the authenticated device.
            sdk=Ed25519PrivateKey.generate()
            cert_body={'domain':'sfera-mesh-cipher-device-v1','network':'lab','genesis':directory.pin,
                       'owner':fixture['creator'],'device':fixture['device'],'device_public':device.public_key().public_bytes_raw().hex(),
                       'ed25519':base64.b64encode(sdk.public_key().public_bytes_raw()).decode().rstrip('='),
                       'curve25519':base64.b64encode(Ed25519PrivateKey.generate().public_key().public_bytes_raw()).decode().rstrip('=')}
            state['cipher_devices']={fixture['creator']+':'+fixture['device']:{'certificate':{'body':cert_body,'signature':device.sign(canonical(cert_body)).hex()}}}
            sdk_user='@'+fixture['creator']+':'+directory.pin+'.sphere'
            doc={'key':base64.b64encode(Ed25519PrivateKey.generate().public_key().public_bytes_raw()).decode().rstrip('=')}
            sig=base64.b64encode(sdk.sign(canonical(doc))).decode().rstrip('=')
            doc['signatures']={sdk_user:{'ed25519:'+fixture['device']:sig}}
            key_body={'domain':'sfera-mesh-application-key-v1','network':'lab','genesis':directory.pin,'owner':fixture['creator'],
                      'device':fixture['device'],'devices_version':1,'request':'api-upload-1','kind':'upload',
                      'dialog':'','target_owner':'','target_device':'','keys_utf8':canonical({'signed_curve25519:one':doc}).hex()}
            key_record={'body':key_body,'signature':base64.b64encode(sdk.sign(canonical(key_body))).decode().rstrip('=')}
            assert request(views.keys,{'record':key_record}).status_code==401
            assert request(views.keys,{'record':key_record},str(plain)).status_code==401
            pending=request(views.keys,{'record':key_record},token)
            assert pending.status_code==202 and 'receipt' not in pending.data,pending.data
            assert not state.get('application_keys'),'pending command mutated verified snapshot'
            state['application_keys']=[{'record':key_record,'digest':sha256(canonical(key_record)).hexdigest(),'key_id':'','key_utf8':''}]
            assert request(views.keys,{'record':key_record},token).status_code==200
            wrong=copy.deepcopy(key_record);wrong['body']['owner']='f'*64
            assert request(views.keys,{'record':wrong},token).status_code==409
            # Exercise the actual consumer adapter. It must use signed target
            # bytes and never fall through to legacy unsigned routing.
            packet=json.loads(Path('output/mesh-application-20261119/signal-client-fixture.json').read_text());now=int(time.time())
            packet['body'].update(issued_at=now,expires_at=now+30);packet['signature']=device.sign(canonical(packet['body'])).hex()
            routed=[]
            class Relay:
                def forward(self,value,user,claim):
                    backend.require(user,claim);checked=verify_signal(value,directory);routed.append(checked);return {'routed':True}
            async def websocket_check():
                consumer=SignalingConsumer();consumer.user_id=str(access['user_id']);consumer.scope={'subprotocols':['ionik.jwt',token]}
                notices=[]
                async def capture(**event):notices.append(json.loads(event['text_data']))
                consumer.send=capture
                SignalingConsumer._users[consumer.user_id]={'channel':'isolated-caller','in_call_with':None}
                try:
                    with patch.object(runtime,'signal_relay',return_value=Relay()):
                        await consumer.receive(json.dumps({'type':'offer','to':'tampered-unsigned-target','mesh_proof':packet}))
                        assert len(routed)==1 and SignalingConsumer._users[consumer.user_id]['in_call_with']==routed[0]['signal']['to']
                        await consumer.receive(json.dumps({'type':'offer','to':routed[0]['signal']['to']}))
                        assert notices[-1]['type']=='signal-rejected' and len(routed)==1
                finally:SignalingConsumer._users.pop(consumer.user_id,None)
            asyncio.run(websocket_check())
            print('Distributed JWT/DRF/Channels: device-only login, pending vs confirmed DM/profile/SDK keys, cipher-only SQL, command actor binding, unsigned JWT refusal and signed signaling routing passed')
    finally:
        backend.close()
        for connection in connections.all():connection.close()
