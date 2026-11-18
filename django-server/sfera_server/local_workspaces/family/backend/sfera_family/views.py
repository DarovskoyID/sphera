"""Family centre API (mounted at /api/family/).

A household: some adults, and the children whose accounts they manage. What a
child's account gets is the content filter locked on at its widest scope, and
friendships that do not happen until a parent says so (core enforces both via
the IS_MANAGED hook this module answers).

Any parent may act for any child in the family: pairing each child with one
particular adult breaks the moment the other parent is the one holding the phone.
"""
from datetime import timedelta

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Q
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from sfera_auth.models import Friendship, User, UserSettings, enforce_child_settings
from sfera_auth.serializers import FriendshipSerializer, UserSerializer
from sfera_auth.views import AuthRateThrottle, _push_friend_event, audit_event
from sfera_modules import hooks
from sfera_modules.models import UserModule
from sfera_modules.permissions import requires_module

from .models import Family, FamilyLocation, FamilyMembership

MODULE = 'family'
MAX_LIVE_MINUTES = 8 * 60

#: The household's server, when the servers module offers one.
FAMILY_CHANNELS = [('family', 'text', 0), ('notes', 'text', 1), ('Family', 'voice', 2)]


def family_of(user):
    membership = FamilyMembership.objects.filter(user=user).select_related('family').first()
    return membership.family if membership else None


def is_parent(user):
    return FamilyMembership.objects.filter(user=user, role='parent').exists()


def _install(user):
    # Everyone in a household gets the family centre; see CAN_UNINSTALL.
    UserModule.objects.get_or_create(user=user, module_id='family')


def _server(family_row, owner):
    """The family's server, created on first need — only if servers are present."""
    svc = hooks.service('servers.private_guild')
    if svc is None:
        return None
    if family_row.server_id and svc.exists(family_row.server_id):
        return family_row.server_id
    family_row.server_id = svc.create(family_row.name, owner, FAMILY_CHANNELS)
    family_row.save(update_fields=['server_id'])
    return family_row.server_id


def _sync_server(family_row, user, joining):
    svc = hooks.service('servers.private_guild')
    if svc is None or not family_row.server_id:
        return
    if joining:
        role = 'member' if FamilyMembership.objects.filter(user=user, role='child').exists() else 'admin'
        svc.add_member(family_row.server_id, user, role)
    else:
        svc.remove_member(family_row.server_id, user)


def _payload(family_row, request):
    memberships = (FamilyMembership.objects.filter(family=family_row)
                   .select_related('user').order_by('role', 'joined_at'))
    members = [{
        'id': str(m.user.id), 'role': m.role, 'birth_date': m.birth_date, 'joined_at': m.joined_at,
        'user': UserSerializer(m.user, context={'request': request}).data,
    } for m in memberships]

    child_ids = [m.user_id for m in memberships if m.role == 'child']
    waiting = (Friendship.objects.filter(status='awaiting_parent')
               .filter(Q(from_user_id__in=child_ids) | Q(to_user_id__in=child_ids))
               .select_related('from_user', 'to_user').order_by('created_at'))
    approvals = [{
        'id': str(f.id),
        'created_at': f.created_at,
        'child': UserSerializer(f.from_user if f.from_user_id in child_ids else f.to_user, context={'request': request}).data,
        'other': UserSerializer(f.to_user if f.from_user_id in child_ids else f.from_user, context={'request': request}).data,
        'child_asked': f.from_user_id in child_ids,
    } for f in waiting]

    parent = is_parent(request.user)
    me = next(m for m in memberships if m.user_id == request.user.id)
    return {
        'id': str(family_row.id),
        'name': family_row.name,
        'guild_id': str(family_row.server_id) if family_row.server_id else '',
        'invite_code': family_row.invite_code if parent else '',
        'my_role': me.role,
        'members': members,
        'pending_approvals': approvals if parent else [],
    }


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def family(request):
    """GET the caller's family, or POST to start one."""
    existing = family_of(request.user)
    if request.method == 'GET':
        if not existing:
            return Response({'family': None})
        if _server(existing, existing.created_by or request.user):
            for m in FamilyMembership.objects.filter(family=existing).select_related('user'):
                _sync_server(existing, m.user, joining=True)
        return Response({'family': _payload(existing, request)})

    if existing:
        return Response({'error': 'You are already in a family'}, status=status.HTTP_409_CONFLICT)
    if FamilyMembership.objects.filter(user=request.user, role='child').exists():
        return Response({'error': 'Only an adult can start a family'}, status=status.HTTP_403_FORBIDDEN)
    name = str(request.data.get('name', '')).strip()[:60]
    if not name:
        return Response({'error': 'name required'}, status=status.HTTP_400_BAD_REQUEST)

    new_family = Family.objects.create(name=name, created_by=request.user)
    FamilyMembership.objects.create(family=new_family, user=request.user, role='parent')
    _install(request.user)
    _server(new_family, request.user)
    audit_event(request, 'family_created')
    return Response({'family': _payload(new_family, request)}, status=status.HTTP_201_CREATED)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
@throttle_classes([AuthRateThrottle])
def family_join(request):
    """Redeem an invite code and join as a second parent."""
    if family_of(request.user):
        return Response({'error': 'You are already in a family'}, status=status.HTTP_409_CONFLICT)
    target = Family.objects.filter(invite_code=str(request.data.get('invite_code', '')).strip()).first()
    if target is None:
        audit_event(request, 'family_join_failed')
        return Response({'error': 'Unknown code'}, status=status.HTTP_404_NOT_FOUND)
    FamilyMembership.objects.create(family=target, user=request.user, role='parent')
    _install(request.user)
    if _server(target, target.created_by or request.user):
        _sync_server(target, request.user, joining=True)
    audit_event(request, 'family_joined')
    return Response({'family': _payload(target, request)})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
@throttle_classes([AuthRateThrottle])
def family_add_child(request):
    """Create an account for a child and put it under this family's care.

    The parent chooses the password: the account belongs to someone who may be
    too young to keep one, and there is no email on it for a reset.
    """
    family_row = family_of(request.user)
    if not family_row or not is_parent(request.user):
        return Response({'error': 'Only a parent can add a child'}, status=status.HTTP_403_FORBIDDEN)

    username = str(request.data.get('username', '')).strip()
    password = str(request.data.get('password', ''))
    nickname = str(request.data.get('nickname', '')).strip()[:50]
    birth_date = request.data.get('birth_date') or None
    if not username or not password:
        return Response({'error': 'username and password required'}, status=status.HTTP_400_BAD_REQUEST)
    if User.objects.filter(username__iexact=username).exists():
        return Response({'error': 'That username is taken'}, status=status.HTTP_409_CONFLICT)
    try:
        validate_password(password)
    except DjangoValidationError as exc:
        return Response({'error': ' '.join(exc.messages)}, status=status.HTTP_400_BAD_REQUEST)

    child = User.objects.create_user(username=username, password=password, nickname=nickname or username)
    FamilyMembership.objects.create(family=family_row, user=child, role='child', birth_date=birth_date)
    _install(child)
    # Create the settings row now and lock it, rather than waiting for the child's
    # first visit to the settings screen.
    child_settings, _ = UserSettings.objects.get_or_create(user=child)
    enforce_child_settings(child_settings)
    if _server(family_row, request.user):
        _sync_server(family_row, child, joining=True)
    audit_event(request, 'family_child_created', metadata={'child': str(child.id)})
    return Response({'family': _payload(family_row, request)}, status=status.HTTP_201_CREATED)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def family_approval(request, friendship_id):
    """Approve or refuse a friendship a child is party to.

    Approving does not make them friends — it lets the request continue as an
    ordinary one, which the other side still has to accept.
    """
    family_row = family_of(request.user)
    if not family_row or not is_parent(request.user):
        return Response({'error': 'Only a parent can decide this'}, status=status.HTTP_403_FORBIDDEN)
    child_ids = list(FamilyMembership.objects.filter(family=family_row, role='child').values_list('user_id', flat=True))
    friendship = Friendship.objects.filter(
        Q(from_user_id__in=child_ids) | Q(to_user_id__in=child_ids), id=friendship_id, status='awaiting_parent',
    ).first()
    if friendship is None:
        return Response({'error': 'Request not found'}, status=status.HTTP_404_NOT_FOUND)

    if not request.data.get('approve'):
        friendship.status = 'rejected'
        friendship.save(update_fields=['status'])
        audit_event(request, 'family_friend_refused')
        return Response({'family': _payload(family_row, request)})

    friendship.status = 'pending'
    friendship.save(update_fields=['status'])
    audit_event(request, 'family_friend_approved')
    # Only now does the other side hear about it.
    _push_friend_event(str(friendship.to_user_id), 'friend-request',
                       FriendshipSerializer(friendship, context={'request': request}).data)
    return Response({'family': _payload(family_row, request)})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def family_remove_member(request, user_id):
    """Take someone out of the family.

    A parent may remove anyone; anyone may remove themselves. The last parent
    cannot walk out and leave children with nobody to approve anything.
    """
    family_row = family_of(request.user)
    if not family_row:
        return Response({'error': 'You are not in a family'}, status=status.HTTP_404_NOT_FOUND)
    leaving_self = str(user_id) == str(request.user.id)
    if not leaving_self and not is_parent(request.user):
        return Response({'error': 'Only a parent can remove someone else'}, status=status.HTTP_403_FORBIDDEN)
    membership = FamilyMembership.objects.filter(family=family_row, user_id=user_id).select_related('user').first()
    if membership is None:
        return Response({'error': 'Not in this family'}, status=status.HTTP_404_NOT_FOUND)
    if membership.role == 'parent':
        others = FamilyMembership.objects.filter(family=family_row, role='parent').exclude(pk=membership.pk)
        if not others.exists() and FamilyMembership.objects.filter(family=family_row, role='child').exists():
            return Response({'error': 'The last parent cannot leave while there are children'},
                            status=status.HTTP_409_CONFLICT)
    _sync_server(family_row, membership.user, joining=False)
    FamilyLocation.objects.filter(user=membership.user).delete()
    membership.delete()
    audit_event(request, 'family_member_removed', metadata={'member': str(user_id)})
    if leaving_self:
        return Response({'family': None})
    return Response({'family': _payload(family_row, request)})


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def family_locations(request):
    """Where everyone in the household is, for those who are sharing right now."""
    family_row = family_of(request.user)
    if not family_row:
        return Response({'locations': []})
    rows = (FamilyLocation.objects.filter(family=family_row, live_until__gt=timezone.now())
            .select_related('user').order_by('-updated_at'))
    return Response({'locations': [{
        'user': UserSerializer(r.user, context={'request': request}).data,
        'lat': r.lat, 'lng': r.lng, 'label': r.label,
        'updated_at': r.updated_at.isoformat(), 'live_until': r.live_until.isoformat(),
        'is_self': r.user_id == request.user.id,
    } for r in rows]})


@api_view(['POST', 'DELETE'])
@permission_classes([IsAuthenticated])
@requires_module(MODULE)
def my_location(request):
    """Start/refresh (POST lat, lng, label?, minutes?) or stop (DELETE) sharing my location."""
    family_row = family_of(request.user)
    if not family_row:
        return Response({'error': 'You are not in a family'}, status=status.HTTP_404_NOT_FOUND)
    if request.method == 'DELETE':
        FamilyLocation.objects.filter(user=request.user).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
    try:
        lat, lng = float(request.data.get('lat')), float(request.data.get('lng'))
        minutes = int(request.data.get('minutes') or 60)
    except (TypeError, ValueError):
        return Response({'error': 'lat and lng are required'}, status=status.HTTP_400_BAD_REQUEST)
    if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
        return Response({'error': 'coordinates out of range'}, status=status.HTTP_400_BAD_REQUEST)
    existing = FamilyLocation.objects.filter(user=request.user).first()
    until = (existing.live_until if existing and existing.live_until > timezone.now() and 'minutes' not in request.data
             else timezone.now() + timedelta(minutes=max(1, min(minutes, MAX_LIVE_MINUTES))))
    FamilyLocation.objects.update_or_create(user=request.user, defaults={
        'family': family_row, 'lat': round(lat, 6), 'lng': round(lng, 6),
        'label': str(request.data.get('label', ''))[:120], 'live_until': until,
    })
    return Response({'live_until': until.isoformat()})
