"""Mount only implemented distributed routes; legacy registration is not used."""
from django.urls import include,path
from . import friend_delivery
from sfera_auth import mesh_views,views,account_views,cipher_views
from .views import consensus_gateway,current_user,users_list,update_status,conversation_create,conversations,sdk_request,replicated_message_echo
from sfera_messages import views as message_views
from sfera_modules import views as module_views
from . import compatibility
from sfera_modules.loader import url_patterns as module_url_patterns
from sfera_modules.commercial_routes import urlpatterns as commercial_routes

urlpatterns=[
    path('api/distribution/',include('sfera_distribution.urls')),
    path('api/auth/mesh/entry/',mesh_views.entry_probe),
    path('api/auth/mesh/login/challenge/',mesh_views.login_challenge),
    path('api/auth/mesh/login/',mesh_views.login),
    path('api/auth/mesh/login/2fa/',mesh_views.login_second_factor),
    path('api/auth/me/',current_user),
    path('api/auth/me/update/',update_status),
    path('api/auth/users/',users_list),
    path('api/auth/ban-status/',views.ban_status),
    path('api/auth/users/<uuid:user_id>/profile/',views.user_profile),
    path('api/auth/users/<uuid:user_id>/images/<str:kind>/',compatibility.profile_image),
    path('api/auth/users/<uuid:user_id>/mutual-friends/',views.mutual_friends),
    path('api/auth/friends/',views.friends_list),
    path('api/auth/friends/request/',views.friend_request_send),
    path('api/auth/friends/request/<uuid:friendship_id>/accept/',views.friend_request_accept),
    path('api/auth/friends/request/<uuid:friendship_id>/reject/',views.friend_request_reject),
    path('api/auth/friends/<uuid:user_id>/remove/',views.friend_remove),
    path('api/auth/friends/requests/pending/',friend_delivery.pending),
    path('api/auth/blocked/',views.blocked_list),
    path('api/auth/block/',views.block_user),
    path('api/auth/unblock/<uuid:user_id>/',views.unblock_user),
    path('api/auth/devices/',views.device_list),
    path('api/auth/devices/<uuid:device_id>/remove/',compatibility.device_remove),
    path('api/auth/me/sessions/revoke/',compatibility.revoke_sessions),
    path('api/auth/settings/',views.user_settings_get),
    path('api/auth/settings/update/',views.user_settings_update),
    path('api/auth/emojis/',views.emoji_list),
    path('api/auth/emojis/create/',compatibility.emoji_create),
    path('api/auth/emojis/<uuid:emoji_id>/image/',compatibility.emoji_image),
    path('api/auth/emojis/<uuid:emoji_id>/',views.emoji_delete),
    path('api/auth/fcm-token/',views.fcm_token),
    path('api/auth/data-export/',views.data_export_request),
    path('api/auth/data-export/<uuid:export_id>/',views.data_export_status),
    path('api/auth/data-export/<uuid:export_id>/download/',views.data_export_download),
    path('api/auth/mesh/account/head/',account_views.head),
    path('api/auth/mesh/account/publish/',account_views.publish),
    path('api/auth/mesh/account/devices/',account_views.devices),
    path('api/auth/mesh/cipher/device/',cipher_views.device),
    path('api/auth/mesh/cipher/archive-device/',cipher_views.archive_device),
    path('api/auth/mesh/cipher/profile/',cipher_views.profile),
    path('api/auth/mesh/cipher/scope/',cipher_views.scope),
    path('api/modules/',include('sfera_modules.urls')),
    path('api/auth/refresh/',views.refresh_token),
    path('api/auth/logout/',views.logout_view),
    path('api/conversations/create/',conversation_create),
    path('api/conversations/',conversations),
    path('api/conversations/<uuid:conversation_id>/messages/',message_views.message_list),
    path('api/conversations/<uuid:conversation_id>/messages/cipher/send/',replicated_message_echo),
    path('api/ws/authorize/',message_views.ws_authorize),
    path('api/chat-safety/',message_views.chat_safety),
    path('mesh/network/v1/rpc',consensus_gateway),
    *commercial_routes,
    *module_url_patterns(),
]

# Mount the complete existing core API after the mesh-specific overrides.
# Mutations of immutable network identities/archives need their distributed
# protocol and are explicitly unavailable, rather than accidentally using SQL.
from sfera_auth.urls import urlpatterns as auth_patterns
from sfera_messages.urls import urlpatterns as message_patterns
overrides=[
    *[path('api/auth/'+suffix,compatibility.credential_flow) for suffix in (
        'register/','register/send-code/','login/','login/2fa/',
        'password-reset/','password-reset/send-code/')],
    path('api/auth/me/password/',compatibility.unavailable,{'feature':'owner_signed_password_change'}),
    path('api/auth/me/delete/',compatibility.unavailable,{'feature':'network_account_withdrawal'}),
    path('api/auth/mesh/cipher/relay/',sdk_request),
    path('api/conversations/<uuid:conversation_id>/delete/',compatibility.unavailable,{'feature':'distributed_dialog_deletion'}),
    path('api/turn/',compatibility.turn_credentials),
]
urlpatterns=overrides+urlpatterns
auth_overrides={str(p.pattern)[len('api/auth/'):] for p in urlpatterns if str(p.pattern).startswith('api/auth/')}
message_overrides={str(p.pattern)[len('api/'):] for p in urlpatterns if str(p.pattern).startswith('api/')}
urlpatterns += [
    path('api/auth/',include([p for p in auth_patterns if str(p.pattern) not in auth_overrides])),
    path('api/',include([p for p in message_patterns if str(p.pattern) not in message_overrides])),
]
