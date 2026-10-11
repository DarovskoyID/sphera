"""Bitrix24 REST through an incoming webhook (stdlib HTTP, no extra dependencies)."""
import json
import re
import urllib.error
import urllib.request

from sfera_server.metrics import inc as metrics_inc

WEBHOOK_RE = re.compile(r'^https://([a-z0-9.-]+)/rest/(\d+)/([A-Za-z0-9]+)/?$')
TIMEOUT = 15


class BitrixError(Exception):
    pass


def parse_webhook_url(raw: str) -> tuple[str, str]:
    """(normalized url with a trailing slash, portal host) or BitrixError."""
    url = str(raw or '').strip()
    m = WEBHOOK_RE.match(url)
    if not m:
        raise BitrixError('bad_webhook_url')
    return url.rstrip('/') + '/', m.group(1)


def _post(url, body, timeout=TIMEOUT):
    metrics_inc('bitrix_api_requests')
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('Accept', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            data = json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read() or b'{}')
        except ValueError:
            metrics_inc('bitrix_api_errors')
            raise BitrixError(f'HTTP {e.code}') from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        metrics_inc('bitrix_api_errors')
        raise BitrixError(f'network: {e}') from None
    if isinstance(data, dict) and data.get('error'):
        metrics_inc('bitrix_api_errors')
        raise BitrixError(f"{data.get('error')}: {data.get('error_description', '')}".strip(': '))
    return data


class BitrixClient:
    def __init__(self, conn):
        self.conn = conn

    def call(self, method, params=None):
        if not self.conn.configured:
            raise BitrixError('not_configured')
        return _post(f'{self.conn.webhook_url}{method}.json', params or {}).get('result')

    def link(self, entity, entity_id):
        portal = self.conn.portal
        if not portal or not entity_id:
            return ''
        if entity == 'task':
            return f'https://{portal}/company/personal/user/0/tasks/task/view/{entity_id}/'
        return f'https://{portal}/crm/{entity}/details/{entity_id}/'

    # ── API ─────────────────────────────────────────────────────────────────

    def scopes(self):
        return self.call('scope') or []

    def users(self, query=''):
        params = {'FILTER': {'ACTIVE': True}}
        if query:
            params['FILTER']['FIND'] = query
        rows = self.call('user.search' if query else 'user.get', params) or []
        return [{'id': int(u['ID']), 'name': ' '.join(x for x in (u.get('NAME'), u.get('LAST_NAME')) if x) or u.get('EMAIL') or u['ID']} for u in rows[:50]]

    @staticmethod
    def _comms(phone, email):
        fields = {}
        if phone:
            fields['PHONE'] = [{'VALUE': phone, 'VALUE_TYPE': 'WORK'}]
        if email:
            fields['EMAIL'] = [{'VALUE': email, 'VALUE_TYPE': 'WORK'}]
        return fields

    def create_lead(self, *, title, name='', phone='', email='', comment='', amount=None, responsible_id=None):
        fields = {'TITLE': title, 'NAME': name, 'COMMENTS': comment, 'SOURCE_ID': 'OTHER', 'SOURCE_DESCRIPTION': 'Сфера', **self._comms(phone, email)}
        if amount not in (None, ''):
            fields['OPPORTUNITY'] = float(amount)
            fields['CURRENCY_ID'] = 'RUB'
        if responsible_id:
            fields['ASSIGNED_BY_ID'] = int(responsible_id)
        lead_id = self.call('crm.lead.add', {'fields': fields, 'params': {'REGISTER_SONET_EVENT': 'Y'}})
        return {'id': lead_id, 'url': self.link('lead', lead_id)}

    def create_deal(self, *, title, comment='', amount=None, responsible_id=None):
        fields = {'TITLE': title, 'COMMENTS': comment}
        if amount not in (None, ''):
            fields['OPPORTUNITY'] = float(amount)
            fields['CURRENCY_ID'] = 'RUB'
        if responsible_id:
            fields['ASSIGNED_BY_ID'] = int(responsible_id)
        deal_id = self.call('crm.deal.add', {'fields': fields})
        return {'id': deal_id, 'url': self.link('deal', deal_id)}

    def create_task(self, *, title, description='', responsible_id=None, deadline=None):
        fields = {'TITLE': title, 'DESCRIPTION': description}
        if responsible_id:
            fields['RESPONSIBLE_ID'] = int(responsible_id)
        if deadline:
            fields['DEADLINE'] = deadline
        result = self.call('tasks.task.add', {'fields': fields}) or {}
        task_id = (result.get('task') or {}).get('id')
        return {'id': task_id, 'url': self.link('task', task_id)}

    def comment(self, entity, entity_id, text):
        return self.call('crm.timeline.comment.add', {'fields': {'ENTITY_ID': int(entity_id), 'ENTITY_TYPE': entity, 'COMMENT': text}})

    def search(self, query):
        q = str(query)[:100]
        select = ['ID', 'TITLE', 'NAME', 'LAST_NAME', 'OPPORTUNITY', 'CURRENCY_ID', 'STATUS_ID', 'STAGE_ID']
        leads = self.call('crm.lead.list', {'filter': {'%TITLE': q}, 'select': select, 'order': {'ID': 'DESC'}}) or []
        deals = self.call('crm.deal.list', {'filter': {'%TITLE': q}, 'select': select, 'order': {'ID': 'DESC'}}) or []
        contacts = self.call('crm.contact.list', {'filter': {'%LAST_NAME': q}, 'select': ['ID', 'NAME', 'LAST_NAME', 'PHONE', 'EMAIL']}) or []
        if not contacts:
            contacts = self.call('crm.contact.list', {'filter': {'%NAME': q}, 'select': ['ID', 'NAME', 'LAST_NAME', 'PHONE', 'EMAIL']}) or []
        if not contacts and re.search(r'\d{5,}|@', q):
            found = self.call('crm.duplicate.findbycomm', {'type': 'EMAIL' if '@' in q else 'PHONE', 'values': [q], 'entity_type': 'CONTACT'}) or {}
            ids = (found.get('CONTACT') if isinstance(found, dict) else None) or []
            if ids:
                contacts = self.call('crm.contact.list', {'filter': {'ID': ids[:20]}, 'select': ['ID', 'NAME', 'LAST_NAME', 'PHONE', 'EMAIL']}) or []

        def money(x):
            return f"{float(x['OPPORTUNITY']):,.0f} {x.get('CURRENCY_ID') or ''}".strip() if x.get('OPPORTUNITY') else ''

        def comms(x, key):
            return [c.get('VALUE') for c in x.get(key) or [] if c.get('VALUE')]

        return {
            'leads': [{'id': int(x['ID']), 'title': x.get('TITLE') or f"#{x['ID']}", 'amount': money(x), 'url': self.link('lead', x['ID'])} for x in leads[:20]],
            'deals': [{'id': int(x['ID']), 'title': x.get('TITLE') or f"#{x['ID']}", 'amount': money(x), 'url': self.link('deal', x['ID'])} for x in deals[:20]],
            'contacts': [{
                'id': int(x['ID']), 'title': ' '.join(p for p in (x.get('NAME'), x.get('LAST_NAME')) if p) or f"#{x['ID']}",
                'phones': comms(x, 'PHONE'), 'emails': comms(x, 'EMAIL'), 'url': self.link('contact', x['ID']),
            } for x in contacts[:20]],
        }


EVENTS_RU = {
    'ONCRMLEADADD': ('lead', 'Новый лид'), 'ONCRMLEADUPDATE': ('lead', 'Лид изменён'),
    'ONCRMDEALADD': ('deal', 'Новая сделка'), 'ONCRMDEALUPDATE': ('deal', 'Сделка изменена'),
    'ONCRMCONTACTADD': ('contact', 'Новый контакт'), 'ONCRMCOMPANYADD': ('company', 'Новая компания'),
    'ONTASKADD': ('task', 'Новая задача'), 'ONTASKUPDATE': ('task', 'Задача изменена'),
}


def describe_event(form) -> dict:
    """Outgoing webhook payload (form-encoded: event, data[FIELDS][ID], auth[...]) → summary."""
    event = str(form.get('event', '')).upper()
    entity_id = form.get('data[FIELDS][ID]') or form.get('data[FIELDS_AFTER][ID]') or ''
    entity, title = EVENTS_RU.get(event, ('', event or 'Событие'))
    return {'event': event, 'entity': entity, 'id': str(entity_id), 'summary': f'{title} #{entity_id}' if entity_id else title,
            'token': form.get('auth[application_token]', ''), 'domain': form.get('auth[domain]', '')}
