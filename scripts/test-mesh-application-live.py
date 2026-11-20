"""Four real validators: distributed profiles/dialogs and one-validator recovery.

Local isolated network only. Does not claim browser chat/call availability.
"""
import base64
from hashlib import sha256
import json
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'django-server/sfera_server'))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sfera_mesh.storage import canonical
from sfera_mesh.consensus_directory import ConsensusDirectory,rpc
from sfera_mesh.application_catalog import ApplicationCatalog
from sfera_mesh.application_profiles import application_user_id
from sfera_mesh.application_dialogs import dialog_id,conversation_id
from sfera_mesh.application_keys import ApplicationKeyCatalog,replay as replay_keys
from sfera_mesh.application_registration import ApplicationRegistration


def main():
    binary=Path(sys.argv[1]).resolve();processes={};logs=[];gateways=[];runtime=None
    with tempfile.TemporaryDirectory(prefix='application-quorum-live-') as tmp:
        folder=Path(tmp);home=folder/'validators'
        from cryptography.fernet import Fernet
        from django.conf import settings
        aliases=['default']+['entry'+str(index) for index in range(1,7)]
        settings.configure(SECRET_KEY='isolated-live-application-test-only',USE_TZ=True,SFERA_DISTRIBUTED_APPLICATION=True,
            INSTALLED_APPS=['django.contrib.auth','django.contrib.contenttypes','sfera_auth','sfera_messages','sfera_distribution'],
            AUTH_USER_MODEL='sfera_auth.User',MESSAGE_ENCRYPTION_KEY=Fernet.generate_key().decode(),
            DATABASES={alias:{'ENGINE':'django.db.backends.sqlite3','NAME':str(folder/(alias+'.sqlite'))} for alias in aliases})
        import django
        django.setup()
        from django.core.management import call_command
        from django.db import connections
        from sfera_distribution.projection import synchronize
        from sfera_auth.models import User
        from sfera_messages.models import Conversation
        for alias in aliases:
            call_command('migrate',database=alias,verbosity=0,interactive=False)
        call_command('makemigrations','sfera_distribution',check=True,dry_run=True,verbosity=0)
        subprocess.run([str(binary),'--home',str(home),'--init'],check=True,stdout=subprocess.DEVNULL)
        lab=json.loads((home/'lab.json').read_bytes());addresses=[v.replace('tcp://','http://') for v in lab['rpc']]
        genesis=home/'0/config/genesis.json';pin=sha256(genesis.read_bytes()).hexdigest()
        def start(index):
            stream=(folder/('validator-'+str(index)+'-'+str(len(logs))+'.log')).open('wb');logs.append(stream)
            processes[index]=subprocess.Popen([str(binary),'--home',str(home),'--validator',str(index)],stdout=stream,stderr=stream)
        def stop(index):
            process=processes.pop(index);process.terminate();process.wait(timeout=15)
        def wait(check,timeout=50):
            deadline=time.monotonic()+timeout;last=None
            while time.monotonic()<deadline:
                if any(p.poll() is not None for p in processes.values()):raise AssertionError('temporary validator exited')
                try:
                    value=check()
                    if value:return value
                except (ValueError,OSError) as exc:last=exc
                time.sleep(.2)
            raise AssertionError('live application condition timed out: '+str(last))
        def submit(record):
            result=rpc(addresses[1],'broadcast_tx_sync',{'tx':base64.b64encode(canonical(record)).decode()})
            if result.get('code',0):raise ValueError('transaction rejected: '+result.get('log',''))
        readers=[]
        try:
            for index in range(4):start(index)
            wait(lambda:all(int(rpc(a,'status',{})['sync_info']['latest_block_height'])>=2 for a in addresses))
            for index in range(7):
                readers.append(ConsensusDirectory(str(folder/('entry-'+str(index)+'.sqlite')),binary,genesis))
            directory=readers[0];network=directory.network
            wait(lambda:directory.refresh(addresses[1]))
            catalog=ApplicationCatalog(directory,submit);owners=[];keys={};device_keys={};sdk_keys={};devices={}
            for name in ('alice','bob'):
                key=Ed25519PrivateKey.generate();public=key.public_key().public_bytes_raw().hex()
                owner=sha256(b'sfera-mesh-user-v1\0'+bytes.fromhex(public)).hexdigest();owners.append(owner);keys[owner]=key
                b={'domain':'sfera-mesh-account-v1','network':network,'user_id':owner,'public_key':public,'version':1,
                    'previous':'0'*64,'vault_digest':'0'*64,'dialogs_digest':'0'*64}
                account_record={'body':b,'signature':key.sign(canonical(b)).hex()}
                b={'domain':'sfera-mesh-application-profile-v1','network':network,'genesis':pin,'owner':owner,
                    'control_epoch':0,'version':1,'previous':'0'*64,'handle':name,'nickname_utf8':name.encode().hex()}
                record={'body':b,'signature':key.sign(canonical(b)).hex()}
                device=Ed25519PrivateKey.generate();device_public=device.public_key().public_bytes_raw()
                did=sha256(b'sfera-mesh-device-v1\0'+device_public).hexdigest();devices[owner]=did;device_keys[owner]=device
                b={'domain':'sfera-mesh-device-event-lab-v1','network':network,'user_id':owner,'version':1,'previous':'0'*64,
                   'operation':'enroll','device_id':did,'device_public':device_public.hex()}
                event={'body':b,'owner_signature':key.sign(canonical(b)).hex(),'device_signature':device.sign(canonical(b)).hex()}
                bundle={'account':account_record,'profile':record,'device':event}
                registration=ApplicationRegistration(directory,submit)
                for stage,field in (('account','accounts'),('profile','application_profiles'),('device','devices')):
                    result=registration.publish(bundle)
                    assert result['state']=='pending' and result['stage']==stage,result
                    assert 'application_user' not in result
                    wait(lambda f=field:(directory.refresh(addresses[1]),owner in directory.current['state'].get(f,{}))[1])
                result=registration.publish(bundle)
                assert result['state']=='confirmed' and result['application_user']==application_user_id(network,owner)
                sdk=Ed25519PrivateKey.generate();sdk_keys[owner]=sdk
                b={'domain':'sfera-mesh-cipher-device-v1','network':network,'genesis':pin,'owner':owner,'device':did,'device_public':device_public.hex(),
                   'ed25519':base64.b64encode(sdk.public_key().public_bytes_raw()).decode().rstrip('='),
                   'curve25519':base64.b64encode(Ed25519PrivateKey.generate().public_key().public_bytes_raw()).decode().rstrip('=')}
                submit({'body':b,'signature':device.sign(canonical(b)).hex()})
                wait(lambda:(directory.refresh(addresses[1]),owner+':'+did in directory.current['state'].get('cipher_devices',{}))[1])
            members=sorted(owners);creator=members[0]
            b={'domain':'sfera-mesh-application-dialog-device-v1','network':network,'genesis':pin,'creator':creator,'control_epoch':0,'members':members,
               'creator_device':devices[creator],'devices_version':1}
            record={'body':b,'signature':device_keys[creator].sign(canonical(b)).hex()};identity=dialog_id(network,members)
            assert catalog.dialog(record)['state']=='pending'
            wait(lambda:(directory.refresh(addresses[1]),identity in directory.current['state'].get('application_dialogs',{}))[1])
            def key_command(actor,request,kind,docs=None):
                target=owners[1] if actor==owners[0] else owners[0]
                b={'domain':'sfera-mesh-application-key-v1','network':network,'genesis':pin,'owner':actor,'device':devices[actor],
                   'devices_version':1,'request':request,'kind':kind,'dialog':identity if kind=='claim' else '',
                   'target_owner':target if kind=='claim' else '', 'target_device':devices[target] if kind=='claim' else '',
                   'keys_utf8':canonical(docs).hex() if docs is not None else ''}
                return {'body':b,'signature':base64.b64encode(sdk_keys[actor].sign(canonical(b))).decode().rstrip('=')}
            target=owners[1];user='@'+target+':'+pin+'.sphere'
            doc={'key':base64.b64encode(Ed25519PrivateKey.generate().public_key().public_bytes_raw()).decode().rstrip('=')}
            signature=base64.b64encode(sdk_keys[target].sign(canonical(doc))).decode().rstrip('=')
            doc['signatures']={user:{'ed25519:'+devices[target]:signature}}
            key_catalog=ApplicationKeyCatalog(directory,submit)
            upload=key_command(target,'upload-1','upload',{'signed_curve25519:one':doc})
            assert key_catalog.publish(upload)['state']=='pending'
            wait(lambda:(directory.refresh(addresses[1]),len(directory.current['state'].get('application_keys',[]))==1)[1])
            assert key_catalog.publish(upload)['state']=='confirmed'
            claim=key_command(owners[0],'claim-1','claim')
            assert key_catalog.publish(claim)['state']=='pending'
            wait(lambda:(directory.refresh(addresses[1]),len(directory.current['state']['application_keys'])==2)[1])
            first_claim=key_catalog.publish(claim)
            assert first_claim['receipt']['key_id']=='signed_curve25519:one'
            assert key_catalog.publish(claim)==first_claim
            second_claim=key_command(owners[0],'claim-2','claim')
            assert key_catalog.publish(second_claim)['state']=='pending'
            wait(lambda:(directory.refresh(addresses[1]),len(directory.current['state']['application_keys'])==3)[1])
            assert key_catalog.publish(second_claim)['receipt']['key_id']==''
            expected=catalog.public()
            for alias,reader in zip(aliases,readers):
                wait(lambda r=reader:r.refresh(addresses[1]))
                value=ApplicationCatalog(reader,submit).public()
                assert ApplicationKeyCatalog(reader,submit).publish(claim)==first_claim
                replay_keys(reader.current['state'],network,pin)
                assert value['profiles']==expected['profiles'] and value['dialogs']==expected['dialogs']
                result=synchronize(reader,using=alias)
                assert result['accounts']==2 and result['dialogs']==1
                assert {str(pk) for pk in User.objects.using(alias).values_list('pk',flat=True)}=={application_user_id(network,o) for o in owners}
                assert str(Conversation.objects.using(alias).get().pk)==conversation_id(identity)
            stop(0)
            head=directory.current['state']['application_profiles'][owners[0]][-1]
            b=dict(head['record']['body']);b.update(version=2,previous=head['digest'],nickname_utf8='renamed'.encode().hex())
            record={'body':b,'signature':keys[owners[0]].sign(canonical(b)).hex()}
            assert catalog.profile(record)['state']=='pending'
            wait(lambda:(directory.refresh(addresses[1]),directory.current['state']['application_profiles'][owners[0]][-1]['record']['body']['version']==2)[1])
            start(0)
            wait(lambda:int(rpc(addresses[0],'status',{})['sync_info']['latest_block_height'])>=directory.current['state']['height'])
            readers[-1].close();readers[-1]=ConsensusDirectory(str(folder/'entry-6.sqlite'),binary,genesis)
            wait(lambda:readers[-1].refresh(addresses[0]))
            after=ApplicationCatalog(readers[-1],submit).public()
            assert ApplicationKeyCatalog(readers[-1],submit).publish(claim)==first_claim
            assert {p['id'] for p in after['profiles']}=={application_user_id(network,o) for o in owners}
            assert after['dialogs'][0]['id']==conversation_id(identity)
            synchronize(readers[-1],using=aliases[-1])
            assert User.objects.using(aliases[-1]).get(pk=application_user_id(network,owners[0])).nickname=='renamed'
            # Real HTTPS fallback sources: neither the application database nor
            # one common gateway is its authority. Every response still passes
            # the pinned-genesis Go verifier.
            from datetime import datetime,timedelta,timezone
            import ipaddress
            from cryptography import x509
            from cryptography.hazmat.primitives import hashes,serialization
            from cryptography.hazmat.primitives.asymmetric import ec
            from cryptography.x509.oid import NameOID
            from sfera_mesh.consensus_gateway import ConsensusGateway
            from sfera_mesh.identity import node_id
            from sfera_auth.mesh_sessions import Runtime
            tls_key=ec.generate_private_key(ec.SECP256R1());subject=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'isolated application gateway')])
            cert=(x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(tls_key.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(datetime.now(timezone.utc)-timedelta(minutes=1))
                .not_valid_after(datetime.now(timezone.utc)+timedelta(hours=1))
                .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),False)
                .add_extension(x509.SubjectKeyIdentifier.from_public_key(tls_key.public_key()),False)
                .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(tls_key.public_key()),False)
                .add_extension(x509.KeyUsage(digital_signature=True,content_commitment=False,key_encipherment=False,data_encipherment=False,
                    key_agreement=False,key_cert_sign=True,crl_sign=True,encipher_only=False,decipher_only=False),True)
                .add_extension(x509.BasicConstraints(ca=True,path_length=None),True).sign(tls_key,hashes.SHA256()))
            ca=folder/'gateway.pem';ca.write_bytes(cert.public_bytes(serialization.Encoding.PEM));tls_path=folder/'gateway.key'
            tls_path.write_bytes(tls_key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
            class GatewayHandler(BaseHTTPRequestHandler):
                def log_message(self,*args):pass
                def do_POST(self):
                    if self.path!='/mesh/network/v1/rpc':self.send_error(404);return
                    length=int(self.headers.get('Content-Length','0'))
                    if not 1<=length<=100000:self.send_error(413);return
                    result=self.server.gateway.execute(json.loads(self.rfile.read(length)))
                    raw=canonical(result);self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
            origins=[]
            for address in (addresses[1],addresses[2]):
                server=ThreadingHTTPServer(('127.0.0.1',0),GatewayHandler);server.gateway=ConsensusGateway(address)
                context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(str(ca),str(tls_path));server.socket=context.wrap_socket(server.socket,server_side=True)
                thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();gateways.append((server,thread));origins.append('https://127.0.0.1:'+str(server.server_port))
            with socket.socket() as unused:
                unused.bind(('127.0.0.1',0));closed_port=unused.getsockname()[1]
            entry_key=Ed25519PrivateKey.generate();entry_path=folder/'application-entry.key';entry_path.write_bytes(entry_key.private_bytes_raw())
            config={'state':str(folder/'runtime-directory.sqlite'),'sessions':str(folder/'runtime-sessions.sqlite'),
                'verifier':str(binary),'genesis':str(genesis),'entry':node_id(entry_key.public_key().public_bytes_raw()),'identity':str(entry_path),
                'rpc':'http://127.0.0.1:'+str(closed_port),'gateways':origins,'gateway_ca':str(ca),'identity_policy':'consensus-profile-v1'}
            runtime=Runtime(config);assert runtime.fresh().identity_policy=='consensus-profile-v1'
            first_server,first_thread=gateways.pop(0);first_server.shutdown();first_server.server_close();first_thread.join(3)
            runtime.updated=0;runtime.fresh()
            assert User.objects.get(pk=application_user_id(network,owners[0])).nickname=='renamed'
            print(json.dumps({'four_real_validators':True,'seven_verified_entry_readers':True,
                'seven_sql_replicas_projected_from_real_quorum':True,'migrations_and_model_consistency_passed':True,
                'real_https_gateway_failover_without_common_database':True,
                'device_created_dialog_confirmed':True,'one_time_key_consumed_once_across_seven_entries':True,
                'resumable_registration_confirmed_by_real_quorum':True,
                'key_receipt_retry_and_reader_restart':True,
                'same_profiles_and_dialogs':True,'profile_update_with_one_validator_down':True,
                'restarted_validator_and_reader_verified':True,'browser_chat_or_call_tested':False}),flush=True)
        finally:
            if runtime is not None:runtime.close()
            for server,thread in gateways:server.shutdown();server.server_close();thread.join(3)
            for reader in readers:reader.close()
            for index in list(processes):stop(index)
            for stream in logs:stream.close()
            for connection in connections.all():connection.close()


if __name__=='__main__':main()
