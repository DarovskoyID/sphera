from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import path, include
from sfera_server.metrics import status_page, prometheus_metrics
from sfera_modules.loader import url_patterns as module_url_patterns

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/auth/', include('sfera_auth.urls')),
    path('api/bots/', include('sfera_bots.urls')),
    path('api/modules/', include('sfera_modules.urls')),
    *module_url_patterns(),
    path('api/', include('sfera_messages.urls')),
    path('status-<str:date_token>/', status_page),
    path('metrics/', prometheus_metrics),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
