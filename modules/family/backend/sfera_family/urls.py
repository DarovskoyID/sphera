from django.urls import path

from . import views

urlpatterns = [
    path('', views.family),
    path('join/', views.family_join),
    path('children/', views.family_add_child),
    path('approvals/<uuid:friendship_id>/', views.family_approval),
    path('members/<uuid:user_id>/remove/', views.family_remove_member),
    path('locations/', views.family_locations),
    path('location/', views.my_location),
]
