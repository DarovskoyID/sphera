from django.urls import path

from . import views

urlpatterns = [
    path('conferences/', views.conference_list_create),
    path('conferences/<str:slug>/', views.conference_detail),
    path('conferences/<str:slug>/end/', views.conference_end),
    path('conferences/<str:slug>/join/', views.conference_join),
    path('public/<str:slug>/', views.conference_public),
    path('public/<str:slug>/guest/', views.conference_guest),
    path('settings/', views.media_settings),
    path('users/', views.user_search),
]
