from django.urls import path
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView
from . import views

urlpatterns = [
    path('register/', views.register),
    path('login/', TokenObtainPairView.as_view()),
    path('refresh/', TokenRefreshView.as_view()),
    path('me/', views.me),
    path('users/', views.users_list),
    # Friends
    path('friends/', views.friends_list),
    path('friends/request/', views.friend_request_send),
    path('friends/request/<int:friendship_id>/accept/', views.friend_request_accept),
    path('friends/request/<int:friendship_id>/reject/', views.friend_request_reject),
    path('friends/<int:user_id>/remove/', views.friend_remove),
    path('friends/requests/pending/', views.friend_requests_pending),
]
