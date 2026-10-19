from django.urls import path

from . import views

urlpatterns = [
    path('commercial/', views.commercial_catalog),
    path('commercial/activate/', views.commercial_activate),
    path('commercial/<slug:module_id>/view/', views.commercial_view),
    path('commercial/<slug:module_id>/actions/<slug:action_id>/', views.commercial_action),
    path('', views.module_list),
    path('public/', views.public_modules),
    path('<slug:module_id>/install/', views.module_install),
    path('<slug:module_id>/bundle.js', views.module_bundle),
]
