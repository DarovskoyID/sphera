from django.urls import path

from . import views

urlpatterns = [
    path('', views.module_list),
    path('<slug:module_id>/install/', views.module_install),
]
