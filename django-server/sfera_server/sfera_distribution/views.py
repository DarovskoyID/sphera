import logging
from django.conf import settings
from rest_framework.decorators import api_view, authentication_classes, permission_classes, parser_classes, throttle_classes
from rest_framework.parsers import JSONParser
from rest_framework.permissions import AllowAny,IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from sfera_auth.mesh_sessions import MeshJWTAuthentication,MeshUnavailable,submit_account_record,CLAIM
from sfera_mesh.consensus_directory import ConsensusUnavailable
from sfera_mesh.application_catalog import ApplicationCatalog
from .runtime import backend,signal_relay


class PublicApplicationThrottle(AnonRateThrottle):
    scope='distributed_application_public'
    rate='120/min'


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
                      'registration':'signed-public-records-v1','email_registration':False})


@api_view(['GET'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
def current_user(request):
    from sfera_auth.serializers import MeSerializer
    value=dict(MeSerializer(request.user,context={'request':request}).data)
    value['service_capabilities']={'mode':'distributed','legacy_account_bootstrap':False,
                                   'module_catalog':True,'module_management':False,'status_scope':'entry'}
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
@parser_classes([JSONParser])
def update_status(request):
    if (not isinstance(request.data,dict) or set(request.data)!={'status'}
            or request.data['status'] not in ('online','idle','dnd','offline')):
        return _response({'error':'invalid_entry_status'},400)
    from sfera_auth.models import User
    # Presence belongs to this entry, not to owner-signed account metadata.
    User.objects.filter(pk=request.user.pk).update(status=request.data['status'])
    request.user.status=request.data['status']
    return _response({'status':request.user.status,'scope':'entry'})


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
