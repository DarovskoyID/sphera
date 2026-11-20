from django.urls import path
from . import views

urlpatterns=[
    path('config/',views.configuration),
    path('registration/',views.registration),
    path('catalog/',views.catalog),
    path('profiles/',views.profile),
    path('dialogs/',views.dialog),
    path('keys/',views.keys),
    path('signals/relay/',views.relay_signal),
    path('signals/forward/',views.forward_signal),
]
