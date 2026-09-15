from django.urls import path

from . import views

urlpatterns = [
    path('status/', views.status),
    path('settings/', views.settings_view),
    path('pipelines/', views.pipelines),
    path('leads/', views.create_lead),
    path('leads/<int:lead_id>/notes/', views.add_note),
    path('search/', views.search),
    path('events/', views.events),
    path('users/', views.user_search),
    path('webhook/<str:secret>/', views.webhook),
]
