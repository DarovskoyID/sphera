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
        ALLOWED_HOSTS=['testserver'],MEDIA_ROOT=str(Path(tmp)/'media'),MEDIA_URL='/media/',
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
    from sfera_modules.loader import backend_apps
    settings.INSTALLED_APPS += [name for name in backend_apps() if name not in settings.INSTALLED_APPS]
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
    def request(view,data=None,token=None,method='post',**kwargs):
        headers={'HTTP_AUTHORIZATION':'Bearer '+token} if token else {}
        req=getattr(factory,method)('/api/distribution/',data,format='json',**headers)
        return view(req,**kwargs)
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
            assert me.status_code==200 and me.data['service_capabilities']['legacy_account_bootstrap'] is True,me.data
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
            for invalid in ({'status':'invalid'},{'status':['online']}):
                assert request(update,invalid,token,method='patch').status_code==400
            assert request(update,{'status':'online','nickname':'unauthorized-profile-change'},token,method='patch').status_code==409
            changed=request(update,{'status':'online'},token,method='patch')
            assert changed.status_code==200 and changed.data=={'status':'online','scope':'entry'},changed.data
            synchronize(directory)
            assert request(current,token=token,method='get').data['status']=='online'
            # Test the actual expanded UI URLs, not response placeholders.
            def endpoint(path):return resolve(path,urlconf='sfera_distribution.service_urls')
            for path in ('/api/auth/settings/','/api/auth/devices/','/api/auth/emojis/','/api/auth/ban-status/','/api/auth/friends/','/api/auth/blocked/','/api/auth/friends/requests/pending/','/api/conversations/','/api/chat-safety/'):
                matched=endpoint(path);result=request(matched.func,token=token,method='get',**matched.kwargs)
                assert result.status_code==200,(path,result.data)
                assert request(matched.func,method='get',**matched.kwargs).status_code==401,path
            matched=endpoint('/api/auth/users/'+str(user.pk)+'/profile/')
            assert request(matched.func,token=token,method='get',**matched.kwargs).status_code==200
            prefs=endpoint('/api/auth/settings/update/').func
            assert request(prefs,{'theme':'light','notify_mentions':False},token,method='patch').status_code==200
            saved=request(endpoint('/api/auth/settings/').func,token=token,method='get')
            assert saved.data['theme']=='light' and saved.data['notify_mentions'] is False
            from django.test import override_settings
            turn=endpoint('/api/turn/').func
            assert request(turn,method='get').status_code==401
            with override_settings(SFERA_TURN_SECRET='isolated-turn-secret-only',SFERA_TURN_REALM='relay.example.invalid',SFERA_TURN_PORT=3478,SFERA_TURN_TTL=3600):
                ice=request(turn,token=token,method='get');assert ice.status_code==200,ice.data
                assert 'isolated-turn-secret-only' not in json.dumps(ice.data)
                import hmac
                credential=ice.data['iceServers'][1]
                assert credential['username'].endswith(':'+str(user.pk))
                expected=base64.b64encode(hmac.new(b'isolated-turn-secret-only',credential['username'].encode(),__import__('hashlib').sha1).digest()).decode()
                assert credential['credential']==expected and ice['Cache-Control']=='no-store'
            bio=request(update,{'bio':'entry-local profile note','nickname':user.nickname},token,method='patch')
            assert bio.status_code==200 and bio.data['bio']=='entry-local profile note',bio.data
            from django.core.files.uploadedfile import SimpleUploadedFile
            from PIL import Image
            import io
            raw=io.BytesIO();Image.new('RGB',(2,2),'blue').save(raw,format='PNG')
            create=endpoint('/api/auth/emojis/create/').func
            invalid=factory.post('/api/auth/emojis/create/',{'name':'unsafe','image':SimpleUploadedFile('x.svg',b'<svg/>',content_type='image/svg+xml')},format='multipart',HTTP_AUTHORIZATION='Bearer '+token)
            assert create(invalid).status_code==400
            upload=factory.post('/api/auth/emojis/create/',{'name':'valid_qa','image':SimpleUploadedFile('not-an-image.svg',raw.getvalue(),content_type='image/png')},format='multipart',HTTP_AUTHORIZATION='Bearer '+token)
            emoji=create(upload);assert emoji.status_code==201,emoji.data
            image_path=emoji.data['image_url'];matched=endpoint(image_path)
            image=request(matched.func,method='get',**matched.kwargs);assert image.status_code==200 and image['Content-Type']=='image/png';image.close()
            remove=endpoint('/api/auth/emojis/'+str(emoji.data['id'])+'/')
            assert request(remove.func,token=token,method='delete',**remove.kwargs).status_code==204
            assert request(matched.func,method='get',**matched.kwargs).status_code==404
            create_dialog=endpoint('/api/conversations/create/').func
            peer=next(profile['id'] for profile in views.catalog(factory.get('/')).data['profiles'] if profile['id']!=str(user.pk))
            unsigned=request(create_dialog,{'user_id':peer},token)
            assert unsigned.status_code==409 and unsigned.data['error']=='signed_dialog_required',unsigned.data
            assert Conversation.objects.count()==0
            catalog=request(views.catalog,method='get');assert catalog.status_code==200 and len(catalog.data['profiles'])==2
            record=json.loads(Path('output/mesh-application-20261119/device-dialog-client-fixture.json').read_text())
            assert request(views.dialog,{'record':record}).status_code==401
            result=request(views.dialog,{'record':record},token);assert result.status_code==202,result.data
            assert Conversation.objects.count()==0,'pending metadata prematurely created SQL conversation'
            identity=result.data['identity'];state['application_dialogs'][identity]={'record':record,'digest':sha256(canonical(record)).hexdigest()};state['height']+=1
            synchronize(directory)
            assert Conversation.objects.get().cipher_only
            opened=request(create_dialog,{'user_id':peer},token)
            assert opened.status_code==200 and str(opened.data['id'])==str(Conversation.objects.get().pk),opened.data
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
            async def asgi_check():
                from asgiref.testing import ApplicationCommunicator
                from sfera_distribution.asgi import application
                scope={'type':'websocket','path':'/ws/signaling/','headers':[],
                    'query_string':b'','subprotocols':['ionik.jwt',token],
                    'server':('testserver',443),'client':('127.0.0.1',12345),'scheme':'wss'}
                socket=ApplicationCommunicator(application,scope)
                await socket.send_input({'type':'websocket.connect'})
                accepted=await socket.receive_output(timeout=10)
                assert accepted['type']=='websocket.accept' and accepted.get('subprotocol')=='ionik.jwt',accepted
                await socket.send_input({'type':'websocket.receive','text':json.dumps({'type':'offer','to':'unsigned'})})
                for _ in range(8):
                    output=await socket.receive_output(timeout=10)
                    if output['type']=='websocket.send' and json.loads(output.get('text','{}')).get('type')=='signal-rejected':break
                else:raise AssertionError('unsigned websocket signal accepted')
                await socket.send_input({'type':'websocket.disconnect','code':1000});await socket.wait(timeout=10)
                anonymous=ApplicationCommunicator(application,{**scope,'subprotocols':[]})
                await anonymous.send_input({'type':'websocket.connect'})
                assert (await anonymous.receive_output(timeout=10))['type']=='websocket.accept'
                closed=await anonymous.receive_output(timeout=10);assert closed['type']=='websocket.close' and closed['code']==4001,closed
                await anonymous.send_input({'type':'websocket.disconnect','code':4001});await anonymous.wait(timeout=10)
            asyncio.run(asgi_check())
            revoke=endpoint('/api/auth/me/sessions/revoke/').func
            assert request(revoke,token=token).status_code==200
            assert request(current,token=token,method='get').status_code==401
            print('Distributed JWT/DRF/Channels: device-only login, pending vs confirmed DM/profile/SDK keys, cipher-only SQL, command actor binding, unsigned JWT refusal and signed signaling routing passed')
    finally:
        backend.close()
        for connection in connections.all():connection.close()
