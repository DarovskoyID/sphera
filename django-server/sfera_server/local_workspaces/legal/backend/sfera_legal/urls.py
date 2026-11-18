from django.urls import path

from . import views

urlpatterns = [
    path('status/', views.status_view),
    path('settings/', views.settings_view),
    path('conversations/', views.conversations),
    path('packages/', views.package_list_create),
    path('packages/<uuid:package_id>/', views.package_detail),
    path('packages/<uuid:package_id>/seal/', views.package_seal),
    path('packages/<uuid:package_id>/download/<str:fmt>/', views.package_download),
    path('packages/<uuid:package_id>/request-signature/', views.sign_request),
    path('packages/<uuid:package_id>/code/', views.sign_code_request),
    path('packages/<uuid:package_id>/sign/', views.sign),
    path('chain/', views.chain_status),
    path('public/verify/<str:code>/', views.public_verify),
    path('users/', views.user_search),
]
