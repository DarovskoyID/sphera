"""Recover pending requests from other admitted application points."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from datetime import datetime
from threading import BoundedSemaphore
from uuid import UUID

from django.db import IntegrityError, OperationalError, transaction
from time import sleep
from django.db.models import Q
from rest_framework.decorators import api_view, authentication_classes, permission_classes, throttle_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle

from sfera_auth.mesh_sessions import MeshJWTAuthentication
from sfera_auth.models import BlockedUser, Friendship, is_child
from sfera_auth.serializers import FriendshipSerializer
from sfera_mesh.consensus_directory import ConsensusUnavailable
from sfera_mesh.identity import envelope
from sfera_mesh.storage import canonical
from .runtime import sdk_replica

inbox_workers = ThreadPoolExecutor(max_workers=12, thread_name_prefix='friend-inbox')
inbox_slots = BoundedSemaphore(4)


class PeerThrottle(AnonRateThrottle):
    rate = '120/min'


@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([PeerThrottle])
def outgoing(request):
    """Only signed requests from admitted points can retrieve pending rows."""
    try:
        replica = sdk_replica()
        peers = replica.roster()
        replica.nodes.roster = {identity: peer['public_key'] for identity, peer in peers.items()}
        sender, payload = replica.nodes.verify(request.data, 'friend-outgoing-v1')
        if not isinstance(payload, dict) or set(payload) != {'recipient'}:
            raise ValueError('friend_recipient_schema')
        recipient = UUID(payload['recipient'])
        rows = Friendship.objects.filter(to_user_id=recipient, status='pending').order_by('id')
        rows = [[str(identity), str(author), created.isoformat()]
                for identity, author, created in rows.values_list('id', 'from_user_id', 'created_at')[:256]]
        backend = replica.backend
        return Response(envelope(backend.entry_key, backend.directory.network, sender, 'friend-outgoing-reply-v1',
            {'nonce': request.data['record']['nonce'], 'rows': rows}))
    except (ConsensusUnavailable, OSError, ValueError, TypeError, KeyError):
        return Response({'error': 'friend_peer_request_rejected'}, status=403)


def _fetch(replica, identity, peer, recipient):
    from urllib.request import Request, build_opener, ProxyHandler
    from sfera_mesh.consensus_directory import NoRedirect
    from sfera_mesh.public_transport import endpoint_url

    backend = replica.backend
    packet = envelope(backend.entry_key, backend.directory.network, identity, 'friend-outgoing-v1',
                      {'recipient': str(recipient)})
    url = endpoint_url(peer['origin']) + '/api/distribution/friends/outgoing/'
    request = Request(url, data=canonical(packet), headers={'Content-Type': 'application/json'})
    with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=4) as response:
        raw = response.read(65537)
    if len(raw) > 65536:
        raise ValueError('friend_reply_size')
    sender, body = replica.nodes.verify(json.loads(raw), 'friend-outgoing-reply-v1')
    if sender != identity or body['nonce'] != packet['record']['nonce'] or len(body['rows']) > 256:
        raise ValueError('friend_reply_context')
    return [(UUID(row[0]), UUID(row[1]), datetime.fromisoformat(row[2]))
            for row in body['rows'] if isinstance(row, list) and len(row) == 3]


def _merge(recipient, rows):
    from .models import AccountProjection
    authors = {entry.user_id for entry in AccountProjection.objects
               .filter(user_id__in={author for _, author, _ in rows}).select_related('user')
               if not is_child(entry.user)}
    for identity, author, created in rows:
        if author == recipient or author not in authors or created.utcoffset() is None:
            continue
        pair = Q(from_user_id=author, to_user_id=recipient) | Q(from_user_id=recipient, to_user_id=author)
        blocked = Q(blocker_id=author, blocked_id=recipient) | Q(blocker_id=recipient, blocked_id=author)
        try:
            with transaction.atomic():
                if BlockedUser.objects.filter(blocked).exists():
                    continue
                if Friendship.objects.filter(pair, status__in=['accepted', 'awaiting_parent']).exists():
                    continue
                incoming = Friendship.objects.filter(from_user_id=author, to_user_id=recipient).first()
                if incoming:
                    if incoming.status != 'rejected' or incoming.pk == identity or created <= incoming.created_at:
                        continue
                    # Legacy senders reused a rejected request's primary key.
                    # A genuinely new attempt has a fresh ID.
                    incoming.delete()
                Friendship.objects.create(id=identity, from_user_id=author, to_user_id=recipient, status='pending')
                Friendship.objects.filter(pk=identity).update(created_at=created)
        except IntegrityError:
            # A concurrent poll or user's local action won the insert.
            continue


@api_view(['GET'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
def pending(request):
    recipient = request.user.pk
    if is_child(request.user):
        # Keep the same parent-approval boundary for remotely sourced requests.
        rows = Friendship.objects.filter(to_user=request.user, status='pending')
        return Response(FriendshipSerializer(rows, many=True, context={'request': request}).data)
    try:
        replica = sdk_replica()
        peers = replica.roster()
        replica.nodes.roster = {identity: peer['public_key'] for identity, peer in peers.items()}
        if inbox_slots.acquire(blocking=False):
            try:
                jobs = [inbox_workers.submit(_fetch, replica, identity, peer, recipient)
                        for identity, peer in peers.items() if identity != replica.backend.entry]
                for job in as_completed(jobs):
                    try:
                        rows = job.result()
                        for attempt in range(3):
                            try:
                                _merge(recipient, rows)
                                break
                            except OperationalError as error:
                                if 'database is locked' not in str(error):
                                    raise
                                if attempt < 2:
                                    sleep(0.05 * (attempt + 1))
                    except (OSError, ValueError, TypeError, KeyError, ConsensusUnavailable):
                        continue
            finally:
                inbox_slots.release()
    except (ConsensusUnavailable, OSError, ValueError):
        pass  # A temporary peer outage must not hide requests already received.
    rows = Friendship.objects.filter(to_user=request.user, status='pending')
    response = Response(FriendshipSerializer(rows, many=True, context={'request': request}).data)
    response['Cache-Control'] = 'no-store'
    return response
