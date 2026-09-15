from django.urls import path

from . import views

urlpatterns = [
    path('status/', views.status),
    path('settings/', views.settings_view),
    path('entity-sets/', views.entity_sets),
    path('search/', views.search),
    path('records/<str:entity>/<str:key>/', views.record),
    path('counterparties/', views.create_counterparty),
    path('events/', views.events),
    path('users/', views.user_search),
    path('webhook/<str:secret>/', views.webhook),
]
