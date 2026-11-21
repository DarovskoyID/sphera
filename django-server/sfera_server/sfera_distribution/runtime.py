"""Assembly for the opt-in distributed application module, never legacy fallback."""
import atexit
import threading
from asgiref.sync import async_to_sync
from django.conf import settings
from channels.layers import get_channel_layer
from sfera_auth.mesh_sessions import sessions, MeshUnavailable
from .signaling import ApplicationSignalRelay

_relay = None
_sdk = None
_lock = threading.RLock()


def sdk_replica():
    global _sdk
    current=backend()
    with _lock:
        if _sdk is None:
            from pathlib import Path
            from sfera_mesh.cipher_authority import CipherAuthority
            from .sdk_replica import SdkReplica
            from .message_projection import project
            path=Path(settings.DATABASES['default']['NAME']).parent/'sdk-node-replays.sqlite'
            _sdk=SdkReplica(CipherAuthority(current),str(path),project=lambda record:project(current.directory,record))
            atexit.register(_sdk.close)
        if _sdk.backend is not current:raise MeshUnavailable('SDK replica runtime changed; restart is required')
        return _sdk


def backend():
    value = sessions()
    if value.identity_policy != 'consensus-profile-v1':
        raise MeshUnavailable('distributed application identity policy is required')
    return value


def signal_relay():
    global _relay
    current = backend()
    with _lock:
        if _relay is None:
            paths = getattr(settings,'SFERA_DISTRIBUTED_SIGNALING',None)
            if (not isinstance(paths,dict) or set(paths) != {'node_replays','signal_replays'}
                    or current.entry_key is None):
                raise MeshUnavailable('distributed signaling is not configured')
            from pathlib import Path
            normalized=[]
            for name in ('node_replays','signal_replays'):
                if not isinstance(paths[name],str) or not Path(paths[name]).is_absolute():
                    raise MeshUnavailable('absolute durable signaling journals are required')
                normalized.append(str(Path(paths[name]).resolve()))
            if len(set(normalized))!=2:raise MeshUnavailable('separate signaling journals are required')
            def authorize(user,claim):
                from sfera_auth.models import User
                from sfera_auth.mesh_views import _allowed
                actor=User.objects.filter(pk=user).first()
                if actor is None or not _allowed(actor):raise ValueError('signal_account_blocked')
                current.require(str(user),claim)
            def local(checked,packet):
                from sfera_signaling.consumers import SignalingConsumer
                target=SignalingConsumer._users.get(checked['signal']['to'])
                if target is None:return False
                async_to_sync(get_channel_layer().send)(target['channel'],
                    {'type':'signal.forward','data':{**checked['signal'],'mesh_proof':packet}})
                return True
            _relay=ApplicationSignalRelay(current.entry_key,current.directory,paths['node_replays'],paths['signal_replays'],authorize=authorize,local=local)
            atexit.register(_relay.close)
        if _relay.identity!=current.entry or _relay.directory is not current.directory:
            raise MeshUnavailable('signaling runtime changed; restart is required')
        return _relay
