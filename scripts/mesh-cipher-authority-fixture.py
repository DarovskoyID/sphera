"""Stdio-only test fixture. Simulated fresh directory and seeded application logins.

Not an authentication server: never use this fixture for real users or keys.
Node owns the generated test roots; only public documents cross this pipe.
"""
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'django-server' / 'sfera_server'))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sfera_mesh.application_sessions import ApplicationSessions
from sfera_mesh.cipher_authority import CipherAuthority
from sfera_mesh.cipher_relay import CipherRelay
from sfera_mesh.identity import node_id
from sfera_mesh.storage import canonical
from hashlib import sha256
from sfera_mesh.test_cipher_authority import Directory


def main():
    backend = None
    replica_entries=[];replica_nodes={};replica_temp=None
    messages = None
    scoped_members = {}
    def get_members(source, scope):
        return scoped_members.get(source + ':' + scope, scoped_members.get(scope, members))
    try:
        for line in sys.stdin:
            try:
                if len(line) > 262144:
                    raise ValueError('test_input_too_large')
                request = json.loads(line)
                operation = request['operation']
                if operation == 'setup':
                    if backend is not None:
                        raise ValueError('already_initialized')
                    directory = Directory()
                    key = Ed25519PrivateKey.generate()
                    entry = node_id(key.public_key().public_bytes_raw())
                    distributed = request.get('distributed', False)
                    if distributed:
                        from sfera_mesh.distributed_sessions import DistributedApplicationSessions
                        from sfera_mesh.application_dialogs import verify_record
                        from sfera_mesh.application_profiles import validate_profiles
                        state = {'height':1,'accounts': {}, 'devices': {}, 'application_profiles': {},
                                 'cipher_devices': {}, 'application_dialogs': {}}
                        for user in request['users']:
                            owner = user['event']['body']['user_id']
                            profile = user['profile']
                            state['accounts'][owner] = {'record': {'body': {'public_key': user['owner_public']}}}
                            state['devices'][owner] = [{'event': user['event']}]
                            state['application_profiles'][owner] = [{'record': profile, 'digest': sha256(canonical(profile)).hexdigest()}]
                            state['cipher_devices'][owner + ':' + user['event']['body']['device_id']] = {'certificate': user['certificate']}
                        validate_profiles(state, directory.network, directory.pin)
                        identity, digest = verify_record(request['dialog'], state, directory.network, directory.pin)
                        state['application_dialogs'][identity] = {'record': request['dialog'], 'digest': digest}
                        directory.current = {'state': state}
                        directory.cipher_device = lambda owner, device: {'head': state['cipher_devices'].get(owner + ':' + device)}
                        backend = DistributedApplicationSessions(':memory:', directory, entry, entry_key=key)
                        backend.require_consensus_cipher_pins = True
                    else:
                        backend = ApplicationSessions(':memory:', directory, entry, entry_key=key)
                    authority, claims, members = CipherAuthority(backend), {}, []
                    for user in request['users']:
                        owner, device = user['event']['body']['user_id'], user['event']['body']['device_id']
                        directory.owners[owner] = (user['owner_public'], [user['event']])
                        claim = {'id': user['session'], 'owner': owner, 'device': device, 'genesis': directory.pin, 'entry': entry}
                        with backend.db:
                            backend.db.execute('INSERT INTO app_identities VALUES(?,?)', (owner, user['user']))
                            backend.db.execute('INSERT INTO app_sessions VALUES(?,?,?,?,?,0)',
                                (claim['id'], user['user'], owner, device, int(time.time()) + 3600))
                        claims[user['user']] = claim
                        members.append(user['user'])
                        if user.get('certificate'):
                            authority.publish(user['user'], claim, user['certificate'])
                    result = {'network': directory.network, 'nodeId': entry,
                        'publicKey': key.public_key().public_bytes_raw().hex(), 'url': 'https://fixture.sphere.invalid',
                        'label': 'Isolated fixture'}
                    if request.get('replicas'):
                        import tempfile
                        from sfera_distribution.sdk_replica import SdkReplica
                        replica_temp=tempfile.TemporaryDirectory()
                        replica_entries=[(backend,authority,claims)]
                        for index in range(1,7):
                            k=Ed25519PrivateKey.generate();b=DistributedApplicationSessions(str(Path(replica_temp.name)/(str(index)+'.sqlite')),directory,node_id(k.public_key().public_bytes_raw()),entry_key=k)
                            b.require_consensus_cipher_pins=True;a=CipherAuthority(b);cs={}
                            for user in request['users']:
                                owner=user['event']['body']['user_id'];device=user['event']['body']['device_id']
                                cs[user['user']]={'id':user['session'],'owner':owner,'device':device,'genesis':directory.pin,'entry':b.entry}
                                with b.db:
                                    b.db.execute('INSERT INTO app_identities VALUES(?,?)',(owner,user['user']))
                                    b.db.execute('INSERT INTO app_sessions VALUES(?,?,?,?,?,0)',(user['session'],user['user'],owner,device,int(time.time())+3600))
                            replica_entries.append((b,a,cs))
                        roster={b.entry:{'public_key':b.entry_key.public_key().public_bytes_raw(),'origin':b.entry} for b,_,_ in replica_entries}
                        for index,(b,a,cs) in enumerate(replica_entries):
                            replica_nodes[b.entry]=SdkReplica(a,str(Path(replica_temp.name)/('replay-'+str(index)+'.sqlite')),peers=lambda d:roster,transport=lambda origin,message:replica_nodes[origin].receive(message))
                        result=[{'network':directory.network,'nodeId':b.entry,'publicKey':b.entry_key.public_key().public_bytes_raw().hex(),'url':'https://fixture.sphere.invalid','label':'Replica '+str(i)} for i,(b,_,_) in enumerate(replica_entries)]
                    if request.get('messages'):
                        from mesh_cipher_message_fixture import MessageApiFixture
                        messages = MessageApiFixture(backend, request['users'], guilds=request.get('guilds', False))
                elif operation == 'replica_entry':
                    result=replica_entries[request['entry']][0].entry_proof(request['nonce'])
                elif operation == 'replica_publish':
                    b,a,cs=replica_entries[request['entry']]
                    result=a.publish(request['user'],cs[request['user']],request['certificate'])
                elif operation == 'replica_catalog':
                    from sfera_mesh.application_profiles import public_profiles
                    result={'network':directory.network,'genesis':directory.pin,'profiles':public_profiles(state,directory.network,directory.pin)}
                elif operation == 'replica_scope':
                    b,a,cs=replica_entries[request['entry']]
                    result=a.attest(request['user'],cs[request['user']],'dm',request['scope'],members,request['nonce'])
                elif operation == 'replica_request':
                    b,a,cs=replica_entries[request['entry']]
                    result=replica_nodes[b.entry].request(request['record'],request['user'],cs[request['user']])
                elif operation == 'replica_fixture':
                    result={'state':state,'network':directory.network,'genesis':directory.pin}
                elif operation == 'replica_keys':
                    from sfera_mesh.application_keys import ApplicationKeyCatalog,record as check,perform,replay
                    value=request['record']
                    def commit(value):
                        with directory.lock:
                            check(value,state,directory.network,directory.pin,current=True)
                            pool=replay(state,directory.network,directory.pin);kid,doc=perform(value,state,pool,directory.pin)
                            state.setdefault('application_keys',[]).append({'record':value,'digest':sha256(canonical(value)).hexdigest(),'key_id':kid,'key_utf8':doc})
                    catalog=ApplicationKeyCatalog(directory,commit)
                    catalog.publish(value);result=catalog.publish(value)
                elif operation == 'scope':
                    result = authority.attest(request['user'], claims[request['user']], request['source'],
                        request['scope'], get_members(request['source'], request['scope']), request['nonce'])
                elif operation == 'publish':
                    result = authority.publish(request['user'], claims[request['user']], request['certificate'])
                elif operation == 'archive_device_admission':
                    result = authority.archive_device(request['user'], claims[request['user']], request['device'], request['device_public'], request['nonce'])
                elif operation == 'relay':
                    result = CipherRelay(authority).request(request['user'], claims[request['user']],
                        request['source'], request['scope'], request['roster'], request['epoch'], request['request'],
                        get_members(request['source'], request['scope']),
                        revalidate=lambda: get_members(request['source'], request['scope']))
                elif operation == 'store_message':
                    if messages is None:
                        raise ValueError('message_fixture_not_enabled')
                    messages.conversation(request['scope'], get_members('dm', request['scope']))
                    result = messages.request(request['user'], claims[request['user']], request['scope'], request.get('cipher'),
                        data=request.get('data'), authorization=request.get('authorization'))
                elif operation == 'guild_create':
                    messages.guild_conversation(request['guild'], request['scope'], request.get('members', members))
                    result = True
                elif operation == 'guild_request':
                    result = messages.guild_request(request['user'], claims[request['user']], request['guild'], request['scope'],
                        data=request.get('data'), action=request.get('action', 'send'), method=request.get('method', 'post'),
                        authorization=request.get('authorization'))
                elif operation == 'guild_add':
                    from sfera_servers.models import GuildMembership
                    GuildMembership.objects.get_or_create(guild_id=request['guild'], user_id=request['user'])
                    result = True
                elif operation == 'guild_remove':
                    from sfera_servers.models import GuildMembership
                    GuildMembership.objects.filter(guild_id=request['guild'], user_id=request['user']).delete()
                    members = [member for member in members if member != request['user']]
                    result = True
                elif operation == 'guild_delete_fixture':
                    from sfera_servers.models import GuildMessage
                    result = GuildMessage.objects.filter(pk=request['id']).delete()[0]
                elif operation == 'application_access':
                    result = messages.token(request['user'], claims[request['user']])
                elif operation == 'message_status':
                    result = messages.request(request['user'], claims[request['user']], request['scope'],
                        data=request['data'], authorization=request.get('authorization'), action='status')
                elif operation == 'cipher_read':
                    result = messages.request(request['user'], claims[request['user']], request['scope'],
                        data=request['data'], authorization=request.get('authorization'), action='read')
                elif operation == 'delete_cipher_fixture':
                    # Test-only SQL deletion; the HTTP deletion view is covered
                    # independently. Never used with an installed database.
                    from sfera_messages.models import Message
                    result = Message.objects.filter(pk=request['id'], author_id=request['user']).delete()[0]
                elif operation == 'enable_delivery':
                    messages.enable_delivery(); result = True
                elif operation == 'confirm_delivery':
                    result = messages.confirm_delivery()
                elif operation == 'read_messages':
                    result = messages.request(request['user'], claims[request['user']], request['scope'], method='get')
                elif operation == 'entry_probe':
                    result = backend.entry_proof(request['nonce'])
                elif operation in ('archive_deletions', 'archive_deletion_page'):
                    # Test-only simulated consensus deletion boundary.
                    user = request['user']
                    backend.require(user, claims[user])
                    now = int(time.time())
                    body = {'domain': 'sfera-mesh-archive-deletions-v1', 'network': directory.network,
                        'genesis': directory.pin, 'entry': entry, 'user': user, 'owner': claims[user]['owner'],
                        'publisher': 'c' * 64, 'source': 'dm', 'scope': request['scope'],
                        'root': request['root'], 'version': request['version'], 'deleted': request['deleted'],
                        'nonce': request['nonce'], 'issued_at': now, 'expires_at': now + 15,
                        'authority': 'selected_entry_verified_consensus'}
                    if operation == 'archive_deletion_page':
                        body.update(domain='sfera-mesh-archive-deletion-page-v2', before=request.get('before'),
                            next_before=request.get('next_before'), total_deleted=request['total_deleted'])
                    result = {'body': body, 'signature': key.sign(canonical(body)).hex()}
                elif operation == 'members':
                    if 'scope' in request:
                        scoped_members[(request.get('source') + ':' if request.get('source') else '') + request['scope']] = request['members']
                    else:
                        members = request['members']
                    result = True
                elif operation == 'event':
                    directory.owners[request['owner']][1].append(request['event']); result = True
                elif operation == 'switch_device_fixture':
                    # Test-only admission/session boundary. Production publication
                    # and device-only login have separate JWT/BFT coverage.
                    user = request['user']
                    prior = claims[user]
                    claim = {**prior, 'id': request['session'], 'device': request['device']}
                    with backend.db:
                        backend.db.execute('INSERT INTO app_sessions VALUES(?,?,?,?,?,0)',
                            (claim['id'], user, claim['owner'], claim['device'], int(time.time()) + 3600))
                    claims[user] = claim
                    result = messages.token(user, claim)
                elif operation == 'available':
                    directory.available = request['value']; result = True
                else:
                    raise ValueError('unknown_test_operation')
                print(canonical({'result': result}).decode(), flush=True)
            except Exception as exc:
                print(canonical({'error': str(exc)}).decode(), flush=True)
    finally:
        for replica in replica_nodes.values():replica.close()
        for b,_,_ in replica_entries[1:]:b.close()
        if replica_temp:replica_temp.cleanup()
        if messages is not None:
            messages.close()
        if backend is not None:
            backend.close()


if __name__ == '__main__':
    main()
