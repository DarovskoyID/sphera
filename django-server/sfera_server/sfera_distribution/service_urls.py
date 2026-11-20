"""Mount only implemented distributed routes; legacy registration is not used."""
from django.urls import include,path
from sfera_auth import mesh_views,views
from .views import consensus_gateway,current_user
from sfera_modules import views as module_views

urlpatterns=[
    path('api/distribution/',include('sfera_distribution.urls')),
    path('api/auth/mesh/entry/',mesh_views.entry_probe),
    path('api/auth/mesh/login/challenge/',mesh_views.login_challenge),
    path('api/auth/mesh/login/',mesh_views.login),
    path('api/auth/mesh/login/2fa/',mesh_views.login_second_factor),
    path('api/auth/me/',current_user),
    path('api/modules/',module_views.module_list),
    path('api/modules/public/',module_views.public_modules),
    path('api/auth/refresh/',views.refresh_token),
    path('api/auth/logout/',views.logout_view),
    path('mesh/network/v1/rpc',consensus_gateway),
]
