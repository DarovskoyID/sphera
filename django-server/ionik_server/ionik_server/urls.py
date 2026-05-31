from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import path, include
from ionik_server.metrics import prometheus_metrics
from django.http import HttpResponse
from django.shortcuts import redirect
from datetime import date

def _grafana_redirect(request, date_token):
    if date_token != date.today().strftime('%Y-%m-%d'):
        return HttpResponse('Not Found', status=404)
    return redirect('/grafana/')

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/auth/', include('ionik_auth.urls')),
    path('api/', include('ionik_messages.urls')),
    path('status-<str:date_token>/', _grafana_redirect),
    path('metrics/', prometheus_metrics),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
