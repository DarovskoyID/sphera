"""Entry-local UI services; network identities stay consensus controlled."""
import re
from pathlib import Path
from django.conf import settings
from django.http import FileResponse
from rest_framework.decorators import api_view,authentication_classes,permission_classes,parser_classes
from rest_framework.parsers import MultiPartParser,FormParser
from rest_framework.permissions import AllowAny,IsAuthenticated
from rest_framework.response import Response
from sfera_auth.mesh_sessions import MeshJWTAuthentication


@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
@parser_classes([MultiPartParser,FormParser])
def emoji_create(request):
    from PIL import Image,UnidentifiedImageError
    from sfera_auth.models import CustomEmoji
    from sfera_auth.serializers import CustomEmojiSerializer
    image=request.FILES.get('image');name=request.data.get('name','')
    if not isinstance(name,str) or not re.fullmatch('[a-z0-9_]{1,50}',name) or image is None or image.size>4*1024*1024:
        return Response({'error':'invalid_emoji'},status=400)
    try:
        with Image.open(image) as parsed:
            if parsed.format not in ('PNG','JPEG','GIF','WEBP') or parsed.width*parsed.height>4096*4096:
                raise ValueError('invalid_emoji_image')
            extension={'PNG':'.png','JPEG':'.jpg','GIF':'.gif','WEBP':'.webp'}[parsed.format]
            parsed.verify()
        image.seek(0);image.name='emoji'+extension
    except (OSError,ValueError,UnidentifiedImageError,Image.DecompressionBombError):
        return Response({'error':'invalid_emoji_image'},status=400)
    from django.db import IntegrityError,transaction
    if CustomEmoji.objects.filter(name=name).exists():return Response({'error':'emoji_name_reserved'},status=409)
    emoji=CustomEmoji(name=name,created_by=request.user)
    try:
        with transaction.atomic():emoji.image.save(image.name,image,save=True)
    except IntegrityError:
        if emoji.image:emoji.image.delete(save=False)
        return Response({'error':'emoji_name_reserved'},status=409)
    return Response(CustomEmojiSerializer(emoji,context={'request':request}).data,status=201)


@api_view(['GET'])
@authentication_classes([])
@permission_classes([AllowAny])
def emoji_image(request,emoji_id):
    from sfera_auth.models import CustomEmoji
    emoji=CustomEmoji.objects.filter(pk=emoji_id).first()
    if emoji is None or not emoji.image:return Response({'error':'emoji_not_found'},status=404)
    target=Path(emoji.image.path);root=(Path(settings.MEDIA_ROOT)/'emojis').resolve()
    if (target.is_symlink() or root not in target.resolve().parents
            or any(parent.is_symlink() for parent in target.parents) or not target.is_file()):
        return Response({'error':'emoji_not_found'},status=404)
    response=FileResponse(target.open('rb'),content_type={'.png':'image/png','.jpg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'}.get(target.suffix,'application/octet-stream'))
    response['X-Content-Type-Options']='nosniff';response['Cache-Control']='public, max-age=3600'
    return response


@api_view(['GET'])
@authentication_classes([])
@permission_classes([AllowAny])
def profile_image(request,user_id,kind):
    from .models import AccountProjection
    if kind not in ('avatar','banner'):return Response(status=404)
    mapping=AccountProjection.objects.filter(user_id=user_id).select_related('user').first()
    if mapping is None:return Response(status=404)
    private=False
    if kind=='banner':
        from sfera_auth.models import UserSettings,Friendship
        if UserSettings.objects.filter(user_id=user_id,show_profile_to_everyone=False).exists():
            private=True
            try:
                from sfera_auth.mesh_sessions import MeshJWTAuthentication
                from rest_framework_simplejwt.tokens import RefreshToken
                auth=MeshJWTAuthentication()
                result=auth.authenticate(request)
                actor=result[0] if result else auth.get_user(RefreshToken(request.COOKIES[settings.REFRESH_COOKIE_NAME]))
                from django.db.models import Q
                allowed=actor.pk==user_id or Friendship.objects.filter(Q(from_user=actor,to_user_id=user_id)|Q(to_user=actor,from_user_id=user_id),status='accepted').exists()
            except Exception:allowed=False
            if not allowed:return Response(status=404)
    image=getattr(mapping.user,kind)
    if not image:return Response(status=404)
    target=Path(image.path);root=(Path(settings.MEDIA_ROOT)/('avatars' if kind=='avatar' else 'banners')).resolve()
    if (target.is_symlink() or root not in target.resolve().parents
            or any(parent.is_symlink() for parent in target.parents) or not target.is_file()):return Response(status=404)
    response=FileResponse(target.open('rb'),content_type={'.png':'image/png','.jpg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'}.get(target.suffix,'application/octet-stream'))
    response['X-Content-Type-Options']='nosniff';response['Cache-Control']='private, no-store' if private else 'public, max-age=60'
    return response


@api_view(['DELETE'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
def device_remove(request,device_id):
    from sfera_auth.models import UserDevice
    from .runtime import backend
    row=UserDevice.objects.filter(pk=device_id,user=request.user).first()
    if row is None:return Response({'error':'device_not_found'},status=404)
    value=row.device_id or ''
    if value.startswith('mesh:') and re.fullmatch('[0-9a-f]{64}',value[5:]):
        b=backend()
        with b.lock,b.db:
            b.db.execute('UPDATE app_sessions SET revoked=1 WHERE user=? AND device=?',(str(request.user.pk),value[5:]))
    row.delete()
    return Response({'status':'removed','scope':'entry'})


@api_view(['POST'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
def revoke_sessions(request):
    from .runtime import backend
    from sfera_auth.views import _blacklist_user_refresh_tokens,_clear_refresh_cookie,audit_event
    b=backend()
    with b.lock,b.db:b.db.execute('UPDATE app_sessions SET revoked=1 WHERE user=?',(str(request.user.pk),))
    _blacklist_user_refresh_tokens(request.user)
    request.user.devices.all().delete()
    audit_event(request,'entry_sessions_revoked')
    response=Response({'status':'ok','scope':'entry'});_clear_refresh_cookie(response)
    return response


@api_view(['GET','POST','PUT','PATCH','DELETE'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
def unavailable(request,feature,**kwargs):
    """An explicit incomplete capability, never a successful mock operation."""
    response=Response({'error':'distributed_feature_unavailable','feature':feature,
        'detail':'This distributed operation is not implemented yet.'},status=503)
    response['Cache-Control']='no-store';return response


@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
def credential_flow(request):
    return Response({'error':'mesh_credential_flow_required',
        'detail':'Use device-key registration/login and owner-signed account recovery.'},status=410)


@api_view(['GET'])
@authentication_classes([MeshJWTAuthentication])
@permission_classes([IsAuthenticated])
def turn_credentials(request):
    import time,hmac,hashlib,base64
    secret=getattr(settings,'SFERA_TURN_SECRET','')
    if not secret:return Response({'error':'turn_not_configured'},status=503)
    host=settings.SFERA_TURN_REALM;port=settings.SFERA_TURN_PORT
    expires=int(time.time()//300)*300+settings.SFERA_TURN_TTL
    username=f'{expires}:{request.user.pk}'
    credential=base64.b64encode(hmac.new(secret.encode(),username.encode(),hashlib.sha1).digest()).decode()
    response=Response({'iceServers':[{'urls':f'stun:{host}:{port}'},
        {'urls':[f'turn:{host}:{port}?transport=udp',f'turn:{host}:{port}?transport=tcp'],
         'username':username,'credential':credential}],'node':host,'expires_at':expires})
    response['Cache-Control']='no-store';return response
