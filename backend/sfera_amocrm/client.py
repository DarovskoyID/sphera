"""amoCRM REST API v4 client (stdlib HTTP, no extra dependencies)."""
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import timedelta

from django.utils import timezone

DOMAIN_RE = re.compile(r'^[a-z0-9-]+\.(amocrm\.(ru|com)|kommo\.com)$')
TIMEOUT = 15


class AmoError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def clean_domain(raw: str) -> str:
    d = str(raw or '').strip().lower()
    d = re.sub(r'^https?://', '', d).split('/')[0]
    if d and '.' not in d:
        d = f'{d}.amocrm.ru'
    if d and not DOMAIN_RE.match(d):
        raise AmoError('bad_domain')
    return d


def _request(method, url, token=None, body=None, timeout=TIMEOUT):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Accept', 'application/json')
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read()[:500].decode('utf-8', 'replace')
        raise AmoError(f'HTTP {e.code}: {detail}', e.code) from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise AmoError(f'network: {e}') from None


class AmoClient:
    def __init__(self, conn):
        self.conn = conn

    @property
    def base(self):
        return f'https://{self.conn.domain}'

    # ── Tokens ──────────────────────────────────────────────────────────────

    def exchange_code(self, code: str):
        c = self.conn
        data = _request('POST', f'{self.base}/oauth2/access_token', body={
            'client_id': c.client_id, 'client_secret': c.client_secret, 'grant_type': 'authorization_code',
            'code': code, 'redirect_uri': c.redirect_uri,
        })
        self._store_tokens(data)

    def _store_tokens(self, data):
        c = self.conn
        c.access_token = data['access_token']
        c.refresh_token = data.get('refresh_token', '')
        c.token_expires_at = timezone.now() + timedelta(seconds=int(data.get('expires_in', 86400)))
        c.save()

    def _refresh_if_needed(self):
        c = self.conn
        if not c.encrypted_refresh_token or not c.token_expires_at:
            return  # long-lived token
        if c.token_expires_at - timezone.now() > timedelta(minutes=5):
            return
        data = _request('POST', f'{self.base}/oauth2/access_token', body={
            'client_id': c.client_id, 'client_secret': c.client_secret, 'grant_type': 'refresh_token',
            'refresh_token': c.refresh_token, 'redirect_uri': c.redirect_uri,
        })
        self._store_tokens(data)

    def call(self, method, path, body=None, query=None):
        if not self.conn.configured:
            raise AmoError('not_configured')
        self._refresh_if_needed()
        url = f'{self.base}{path}'
        if query:
            url += '?' + urllib.parse.urlencode(query, doseq=True)
        return _request(method, url, self.conn.access_token, body)

    # ── API ─────────────────────────────────────────────────────────────────

    def account(self):
        return self.call('GET', '/api/v4/account')

    def pipelines(self):
        data = self.call('GET', '/api/v4/leads/pipelines')
        return [
            {'id': p['id'], 'name': p['name'], 'statuses': [{'id': s['id'], 'name': s['name'], 'color': s.get('color')}
                                                          for s in p.get('_embedded', {}).get('statuses', [])]}
            for p in data.get('_embedded', {}).get('pipelines', [])
        ]

    def create_lead(self, *, name, price=None, contact_name='', phone='', email='', note='', pipeline_id=None, responsible_id=None):
        lead = {'name': name}
        if price not in (None, ''):
            lead['price'] = int(float(price))
        if pipeline_id:
            lead['pipeline_id'] = int(pipeline_id)
        if responsible_id:
            lead['responsible_user_id'] = int(responsible_id)
        fields = []
        if phone:
            fields.append({'field_code': 'PHONE', 'values': [{'value': phone, 'enum_code': 'WORK'}]})
        if email:
            fields.append({'field_code': 'EMAIL', 'values': [{'value': email, 'enum_code': 'WORK'}]})
        if contact_name or fields:
            contact = {'name': contact_name or phone or email}
            if fields:
                contact['custom_fields_values'] = fields
            lead['_embedded'] = {'contacts': [contact]}
        created = self.call('POST', '/api/v4/leads/complex', body=[lead])
        item = created[0] if isinstance(created, list) and created else {}
        lead_id = item.get('id')
        if lead_id and note:
            self.add_note(lead_id, note)
        return {'id': lead_id, 'contact_id': item.get('contact_id'), 'url': self.lead_url(lead_id)}

    def add_note(self, lead_id, text):
        return self.call('POST', f'/api/v4/leads/{int(lead_id)}/notes', body=[{'note_type': 'common', 'params': {'text': text[:20000]}}])

    def add_task(self, lead_id, text, due_ts):
        return self.call('POST', '/api/v4/tasks', body=[{
            'text': text[:2000], 'complete_till': int(due_ts), 'entity_id': int(lead_id), 'entity_type': 'leads',
        }])

    def search(self, query):
        q = str(query)[:100]
        leads = self.call('GET', '/api/v4/leads', query={'query': q, 'limit': 20, 'with': 'contacts'}) or {}
        contacts = self.call('GET', '/api/v4/contacts', query={'query': q, 'limit': 20}) or {}
        return {
            'leads': [{
                'id': x['id'], 'name': x.get('name') or f"#{x['id']}", 'price': x.get('price'), 'status_id': x.get('status_id'),
                'pipeline_id': x.get('pipeline_id'), 'updated_at': x.get('updated_at'), 'url': self.lead_url(x['id']),
            } for x in (leads.get('_embedded') or {}).get('leads', [])],
            'contacts': [{
                'id': x['id'], 'name': x.get('name') or f"#{x['id']}", 'url': f"{self.base}/contacts/detail/{x['id']}",
                'phones': _field_values(x, 'PHONE'), 'emails': _field_values(x, 'EMAIL'),
            } for x in (contacts.get('_embedded') or {}).get('contacts', [])],
        }

    def lead_url(self, lead_id):
        return f'{self.base}/leads/detail/{lead_id}' if lead_id else ''


def _field_values(entity, code):
    out = []
    for f in entity.get('custom_fields_values') or []:
        if f.get('field_code') == code:
            out.extend(v.get('value') for v in f.get('values') or [] if v.get('value'))
    return out


def parse_webhook(form) -> list[dict]:
    """amoCRM webhooks are form-encoded: leads[status][0][id]=… → [{entity, action, id, name, …}]."""
    groups: dict[tuple, dict] = {}
    pattern = re.compile(r'^(leads|contacts|companies|tasks|customers|unsorted|message)\[(\w+)\]\[(\d+)\]\[(\w+)\]$')
    for key in form.keys():
        m = pattern.match(key)
        if not m:
            continue
        entity, action, index, field = m.groups()
        groups.setdefault((entity, action, index), {'entity': entity, 'action': action})[field] = form.get(key)
    return list(groups.values())


def now_ts():
    return int(time.time())
