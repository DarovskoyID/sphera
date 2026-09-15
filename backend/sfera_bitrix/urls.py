from django.urls import path

from . import views

urlpatterns = [
    path('status/', views.status),
    path('settings/', views.settings_view),
    path('portal-users/', views.portal_users),
    path('create/<str:kind>/', views.create),
    path('comment/<str:entity>/<int:entity_id>/', views.comment),
    path('search/', views.search),
    path('events/', views.events),
    path('users/', views.user_search),
    path('webhook/<str:secret>/', views.webhook),
]
