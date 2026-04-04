from django.urls import path
from rest_framework_simplejwt.views import (
    TokenObtainPairView, TokenRefreshView,
)
from . import views

urlpatterns = [
    path('register/', views.register),
    path('login/', TokenObtainPairView.as_view()),
    path('refresh/', TokenRefreshView.as_view()),
    path('me/', views.me),
    path('me/update/', views.update_profile),
    path('me/password/', views.change_password),
    path('me/delete/', views.delete_account),
    path('users/', views.users_list),
    # Friends
    path('friends/', views.friends_list),
    path('friends/request/', views.friend_request_send),
    path('friends/request/<int:friendship_id>/accept/',
         views.friend_request_accept),
    path('friends/request/<int:friendship_id>/reject/',
         views.friend_request_reject),
    path('friends/<int:user_id>/remove/', views.friend_remove),
    path('friends/requests/pending/',
         views.friend_requests_pending),
    # Block
    path('blocked/', views.blocked_list),
    path('block/', views.block_user),
    path('unblock/<int:user_id>/', views.unblock_user),
    # Devices
    path('devices/', views.device_list),
    path('devices/<int:device_id>/remove/', views.device_remove),
    # Settings
    path('settings/', views.user_settings_get),
    path('settings/update/', views.user_settings_update),
    # Custom Emojis
    path('emojis/', views.emoji_list),
    path('emojis/create/', views.emoji_create),
    path('emojis/<int:emoji_id>/', views.emoji_delete),
]
