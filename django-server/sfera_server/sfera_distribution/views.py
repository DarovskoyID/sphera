import logging
from django.conf import settings
from rest_framework.decorators import api_view, authentication_classes, permission_classes, parser_classes, throttle_classes
from rest_framework.parsers import JSONParser,MultiPartParser,FormParser
from rest_framework.permissions import AllowAny,IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from sfera_auth.mesh_sessions import MeshJWTAuthentication,MeshUnavailable,submit_account_record,CLAIM
from sfera_mesh.consensus_directory import ConsensusUnavailable
from sfera_mesh.application_catalog import ApplicationCatalog
from .runtime import backend,signal_relay,sdk_replica
from .capabilities import capabilities


class PublicApplicationThrottle(AnonRateThrottle):
    scope='distributed_application_public'
    rate='120/min'


@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@parser_classes([JSONParser])
def sdk_request(request):
    try:
        if set(request.data)!={'record'}:raise ValueError('sdk_request_schema')
        result=sdk_replica().request(request.data['record'],str(request.user.pk),request.auth[CLAIM])
    except ConsensusUnavailable as exc:raise MeshUnavailable() from exc
    except (OSError,ValueError,TypeError,KeyError) as exc:
        if 'quorum_unavailable' in str(exc):raise MeshUnavailable() from exc
        return _response({'error':'sdk_relay_rejected'},409)
    return _response(result)


@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
@parser_classes([JSONParser])
@throttle_classes([PublicApplicationThrottle])
def sdk_replica_receive(request):
    try:result=sdk_replica().receive(request.data)
    except ConsensusUnavailable as exc:raise MeshUnavailable() from exc
    except (OSError,ValueError,TypeError,KeyError) as exc:
        import re
        reason=str(exc) if isinstance(exc,ValueError) and re.fullmatch('[a-z][a-z0-9_]{0,95}',str(exc)) else type(exc).__name__
        logging.getLogger(__name__).warning('SDK replica request rejected: %s',reason)
        return _response({'error':'sdk_replica_rejected'},403)
    return _response(result)


@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@parser_classes([JSONParser])
def replicated_message_echo(request,conversation_id):
    from hashlib import sha256
    from sfera_mesh.storage import canonical
    from sfera_messages.dm_cipher import parse
    from sfera_messages.models import Message
    from sfera_messages.serializers import MessageSerializer
    try:
        if set(request.data)-{'cipher','nonce'} or 'cipher' not in request.data:raise ValueError('message_schema')
        value=parse(request.data['cipher'],conversation_id,author=request.user.pk)
        replica=sdk_replica();b=replica.backend
        with b.lock:
            stored=b.db.execute('SELECT m.digest FROM sdk_replica_messages m JOIN sdk_replica_commits c ON c.id=m.operation WHERE m.id=? AND m.scope=? AND m.owner=?',
                (value['id'],str(conversation_id),request.auth[CLAIM]['owner'])).fetchone()
        if stored!=(sha256(canonical(value)).hexdigest(),):return _response({'error':'signed_message_replication_required'},409)
        row=Message.objects.get(pk=value['id'],conversation_id=conversation_id,author=request.user)
        result=dict(MessageSerializer(row).data)
        if request.data.get('nonce'):result['nonce']=request.data['nonce']
        result['replication_state']='quorum'
        return _response(result)
    except Message.DoesNotExist:return _response({'error':'message_projection_pending'},503)
    except (ValueError,TypeError,KeyError):return _response({'error':'replicated_message_rejected'},409)


def _response(value,status=200):
    result=Response(value,status=status);result['Cache-Control']='no-store';return result


@api_view(['GET'])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([PublicApplicationThrottle])
def catalog(request):
    b=backend()
    return _response(ApplicationCatalog(b.directory,submit_account_record).public())


@api_view(['GET'])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([PublicApplicationThrottle])
def configuration(request):
    b=backend()
    return _response({'mode':'distributed','network':b.directory.network,'genesis':b.directory.pin,'entry':b.entry,
                      'registration':'signed-public-records-v1','email_registration':False,'capabilities':capabilities()})


@api_view(['GET'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
def current_user(request):
    from sfera_auth.serializers import MeSerializer
    request.user.refresh_from_db()
    value=dict(MeSerializer(request.user,context={'request':request}).data)
    value['service_capabilities']=capabilities()
    return _response(value)


@api_view(['GET'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
def users_list(request):
    from sfera_auth.models import User
    from sfera_auth.serializers import UserSerializer
    from sfera_mesh.application_profiles import public_profiles
    b=backend()
    with b.directory.lock:
        b.directory.anchor()
        profiles=public_profiles(b.directory.current['state'],b.directory.network,b.directory.pin)
    # Local/legacy SQL rows are never admitted to the network directory.
    users=User.objects.filter(pk__in=[p['id'] for p in profiles],is_active=True).exclude(pk=request.user.pk).order_by('username')
    return _response(UserSerializer(users,many=True,context={'request':request}).data)


@api_view(['PATCH'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@parser_classes([JSONParser,MultiPartParser,FormParser])
def update_status(request):
    from sfera_auth.serializers import ProfileUpdateSerializer,MeSerializer
    import json
    allowed=set(ProfileUpdateSerializer.Meta.fields)
    request.user.refresh_from_db(fields=['username','nickname'])
    if not hasattr(request.data,'keys') or not request.data or set(request.data)-allowed:
        return _response({'error':'invalid_entry_status'},400)
    if 'nickname' in request.data and request.data['nickname']!=request.user.nickname:
        return _response({'error':'owner_signed_profile_required'},409)
    if set(request.data)!={'status'}:
        data=request.data.copy()
        data.pop('nickname',None)
        if isinstance(data.get('links'),str):
            try:data['links']=json.loads(data['links'])
            except ValueError:return _response({'error':'invalid_profile_links'},400)
        serializer=ProfileUpdateSerializer(request.user,data=data,partial=True)
        if not serializer.is_valid():return _response(serializer.errors,400)
        for field in ('avatar','banner'):
            value=serializer.validated_data.get(field)
            if value:
                suffix={'PNG':'.png','JPEG':'.jpg','GIF':'.gif','WEBP':'.webp'}.get(getattr(getattr(value,'image',None),'format',None))
                if suffix is None or value.size>4*1024*1024:return _response({'error':'invalid_profile_image'},400)
                value.name=field+suffix
        serializer.save()
        value=dict(MeSerializer(request.user,context={'request':request}).data);value['service_capabilities']=capabilities()
        response=_response(value)
        response['X-Sphere-Data-Scope']='entry';return response
    if request.data['status'] not in ('online','idle','dnd','offline'):
        return _response({'error':'invalid_entry_status'},400)
    from sfera_auth.models import User
    # Presence belongs to this entry, not to owner-signed account metadata.
    User.objects.filter(pk=request.user.pk).update(status=request.data['status'])
    request.user.status=request.data['status']
    return _response({'status':request.user.status,'scope':'entry'})


@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@parser_classes([JSONParser])
def conversation_create(request):
    from sfera_auth.models import User
    from .models import AccountProjection,DialogProjection
    from sfera_mesh.application_dialogs import dialog_id
    from sfera_messages.serializers import ConversationSerializer
    import uuid
    try:
        if set(request.data)!={'user_id'}:raise ValueError('invalid_dialog_request')
        peer=uuid.UUID(str(request.data['user_id']))
        if peer==request.user.pk:raise ValueError('self_dialog_not_supported')
    except (ValueError,TypeError):return _response({'error':'invalid_dialog_request'},400)
    other=AccountProjection.objects.filter(user_id=peer).first()
    if other is None or not User.objects.filter(pk=peer,is_active=True).exists():
        return _response({'error':'network_user_not_found'},404)
    b=backend();members=sorted([request.auth[CLAIM]['owner'],other.owner])
    identity=dialog_id(b.directory.network,members)
    mapping=DialogProjection.objects.filter(pk=identity,conversation__participants=request.user).select_related('conversation').first()
    if mapping is None:return _response({'error':'signed_dialog_required','identity':identity},409)
    value=dict(ConversationSerializer(mapping.conversation,context={'request':request}).data)
    value.update(blocked_by_other=False,mesh_history=False,distributed_dialog=True)
    return _response(value)


@api_view(['GET'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
def conversations(request):
    from sfera_messages.models import Conversation
    from sfera_messages.serializers import ConversationSerializer
    from .models import DialogProjection
    backend()
    values=Conversation.objects.filter(pk__in=DialogProjection.objects.values('conversation_id'),participants=request.user,cipher_only=True).order_by('-created_at')
    return _response(ConversationSerializer(values,many=True,context={'request':request}).data)


@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
@parser_classes([JSONParser])
@throttle_classes([PublicApplicationThrottle])
def registration(request):
    from sfera_mesh.application_registration import ApplicationRegistration
    b=backend()
    try:result=ApplicationRegistration(b.directory,submit_account_record).publish(request.data)
    except ConsensusUnavailable as exc:raise MeshUnavailable() from exc
    except (ValueError,TypeError,KeyError):
        logging.getLogger(__name__).exception('Distributed registration rejected')
        return _response({'error':'application_registration_rejected'},409)
    return _response(result,200 if result['state']=='confirmed' else 202)


@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
@parser_classes([JSONParser])
@throttle_classes([PublicApplicationThrottle])
def profile(request):
    b=backend()
    try:
        if set(request.data)!={'record'}:raise ValueError('invalid_application_profile_request')
        result=ApplicationCatalog(b.directory,submit_account_record).profile(request.data['record'])
    except ConsensusUnavailable as exc:raise MeshUnavailable() from exc
    except (ValueError,TypeError,KeyError):return _response({'error':'application_profile_rejected'},409)
    return _response(result,200 if result['state']=='confirmed' else 202)


@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@parser_classes([JSONParser])
def dialog(request):
    b=backend()
    try:
        if set(request.data)!={'record'} or not request.auth or CLAIM not in request.auth:raise ValueError('mesh_session_required')
        record=request.data['record'];body=record['body'];claim=request.auth[CLAIM]
        if (body['domain']!='sfera-mesh-application-dialog-device-v1'
                or body['creator']!=claim['owner'] or body['creator_device']!=claim['device']):
            raise ValueError('application_dialog_actor_mismatch')
        result=ApplicationCatalog(b.directory,submit_account_record).dialog(record)
    except ConsensusUnavailable as exc:raise MeshUnavailable() from exc
    except (ValueError,TypeError,KeyError):return _response({'error':'application_dialog_rejected'},409)
    return _response(result,200 if result['state']=='confirmed' else 202)


@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@parser_classes([JSONParser])
def keys(request):
    from sfera_mesh.application_keys import ApplicationKeyCatalog
    b=backend()
    try:
        if set(request.data)!={'record'} or not request.auth or CLAIM not in request.auth:raise ValueError('mesh_session_required')
        value=request.data['record'];body=value['body'];claim=request.auth[CLAIM]
        if (body['owner'],body['device'])!=(claim['owner'],claim['device']):raise ValueError('application_key_actor_mismatch')
        result=ApplicationKeyCatalog(b.directory,submit_account_record).publish(value)
    except ConsensusUnavailable as exc:raise MeshUnavailable() from exc
    except (ValueError,TypeError,KeyError):return _response({'error':'application_key_rejected'},409)
    return _response(result,200 if result['state']=='confirmed' else 202)


@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
@parser_classes([JSONParser])
@throttle_classes([PublicApplicationThrottle])
def relay_signal(request):
    try:
        result=signal_relay().receive(request.data)
    except ConsensusUnavailable as exc:raise MeshUnavailable() from exc
    except (ValueError,TypeError,KeyError):return _response({'error':'application_signal_rejected'},403)
    return _response(result)


@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@parser_classes([JSONParser])
def forward_signal(request):
    try:
        if set(request.data)!={'packet'} or not request.auth or CLAIM not in request.auth:raise ValueError('mesh_session_required')
        result=signal_relay().forward(request.data['packet'],str(request.user.pk),request.auth[CLAIM])
    except ConsensusUnavailable as exc:raise MeshUnavailable() from exc
    except (ValueError,TypeError,KeyError):return _response({'error':'application_signal_rejected'},403)
    return _response(result)


@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
@parser_classes([JSONParser])
@throttle_classes([PublicApplicationThrottle])
def consensus_gateway(request):
    # Bootstrap relay deliberately does not initialize application sessions or
    # depend on the application's own distributed SQL projection being ready.
    address=getattr(settings,'SFERA_LOCAL_CONSENSUS_RPC','')
    if not address:return _response({'error':'consensus_gateway_not_hosted'},404)
    from sfera_mesh.consensus_gateway import ConsensusGateway
    try:result=ConsensusGateway(address).execute(request.data)
    except (ValueError,TypeError,KeyError):return _response({'error':'invalid_consensus_request'},400)
    return _response(result)
