"""Production Django projection from a real SDK fixture, in a disposable DB."""
from pathlib import Path
import json,os,sys,tempfile,threading,copy
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'django-server/sfera_server'))
from cryptography.fernet import Fernet
from sfera_mesh.test_cipher_authority import Directory
from sfera_mesh.storage import canonical
fixture=json.loads(Path('output/sdk-replica-20261120/message-fixture.json').read_bytes())
with tempfile.TemporaryDirectory() as tmp:
 p=Path(tmp);cfg={'secret_key':'isolated-projection-test-'*4,'message_encryption_key':Fernet.generate_key().decode(),'database':str(p/'application.sqlite'),'allowed_hosts':['testserver'],'mesh':{'identity_policy':'consensus-profile-v1','state':str(p/'directory.sqlite'),'sessions':str(p/'sessions.sqlite'),'identity':str(p/'node.key'),'entry':'a'*64,'genesis':str(p/'genesis.json'),'verifier':str(p/'verifier.exe'),'rpc':'http://127.0.0.1:26657'}}
 config=p/'config.json';config.write_text(json.dumps(cfg));os.environ['SFERA_DISTRIBUTED_CONFIG']=str(config);os.environ['DJANGO_SETTINGS_MODULE']='sfera_distribution.settings'
 import django;django.setup()
 from django.core.management import call_command
 from django.db import connections
 try:
  call_command('migrate',verbosity=0,interactive=False)
  d=Directory();d.current={'state':fixture['state']}
  from sfera_distribution.message_projection import project
  from sfera_messages.models import Message,CipherMessageIdentity
  from sfera_messages.serializers import MessageSerializer
  record=fixture['record'];wire=json.loads(record['body']['request']['body'])['cipher']
  project(d,record);project(d,record)
  assert Message.objects.count()==1 and CipherMessageIdentity.objects.count()==1
  row=Message.objects.get();assert canonical(row.payload)==canonical(wire)
  assert row.content=='' and row.message_type=='cipher'
  result=MessageSerializer(row).data;assert result['payload']==wire
  assert b'Distributed encrypted message' not in row.encrypted_payload.encode()
  corrupt=copy.deepcopy(record);body=json.loads(corrupt['body']['request']['body']);body['cipher']['envelope']['content']['ciphertext']='YWJj';corrupt['body']['request']['body']=json.dumps(body)
  try:project(d,corrupt)
  except ValueError:pass
  else:raise AssertionError('ciphertext substitution accepted')
  print('PASS: real Django migrations, local per-entry encryption, idempotent SDK ciphertext projection, serializer echo and conflicting ciphertext refusal.')
 finally:connections.close_all()
