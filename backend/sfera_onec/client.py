"""1C:Enterprise standard OData interface (v3, JSON) client, stdlib HTTP only.

The interface is published from the designer or the web client:
«Администрирование» → «Интернет-поддержка» / «Стандартный интерфейс OData» — the
objects to expose are chosen there, and a dedicated 1C user reads them.
"""
import base64
import json
import re
import urllib.error
import urllib.parse
import urllib.request

from sfera_server.metrics import inc as metrics_inc

TIMEOUT = 20
ENTITY_RE = re.compile(r'^(Catalog|Document|InformationRegister|AccumulationRegister|ChartOfCharacteristicTypes|Enum|Constant|ExchangePlan|BusinessProcess|Task|DocumentJournal)_[\w]+$', re.UNICODE)
GUID_RE = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
FIELD_RE = re.compile(r'^[\w]{1,100}$', re.UNICODE)
EMPTY_GUID = '00000000-0000-0000-0000-000000000000'


class OneCError(Exception):
    pass


def clean_base_url(raw: str) -> str:
    url = str(raw or '').strip()
    if not url:
        return ''
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ('http', 'https') or not parts.netloc:
        raise OneCError('bad_url')
    path = parts.path if parts.path.endswith('/') else parts.path + '/'
    if 'odata' not in path.lower():
        path += 'odata/standard.odata/'
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, '', ''))


def check_entity(name: str) -> str:
    if not ENTITY_RE.match(str(name or '')):
        raise OneCError('bad_entity')
    return name


def check_field(name: str) -> str:
    if not FIELD_RE.match(str(name or '')):
        raise OneCError('bad_field')
    return name


def odata_string(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _request(method, url, username='', password='', body=None, timeout=TIMEOUT):
    metrics_inc('onec_api_requests')
    data = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Accept', 'application/json')
    if data is not None:
        req.add_header('Content-Type', 'application/json; charset=utf-8')
    if username:
        token = base64.b64encode(f'{username}:{password}'.encode('utf-8')).decode()
        req.add_header('Authorization', f'Basic {token}')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
            return json.loads(raw.decode('utf-8-sig')) if raw else {}
    except urllib.error.HTTPError as e:
        metrics_inc('onec_api_errors')
        text = e.read()[:800].decode('utf-8', 'replace')
        try:
            message = json.loads(text)['odata.error']['message']['value']
        except (ValueError, KeyError, TypeError):
            message = text
        raise OneCError(f'HTTP {e.code}: {message}') from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        metrics_inc('onec_api_errors')
        raise OneCError(f'network: {e}') from None


def _quote_path(name):
    return urllib.parse.quote(name, safe='_()\'=-,')


class OneCClient:
    def __init__(self, conn):
        self.conn = conn

    def _get(self, path, query=None):
        if not self.conn.configured:
            raise OneCError('not_configured')
        q = {'$format': 'json', **(query or {})}
        url = f'{self.conn.base_url}{_quote_path(path)}?{urllib.parse.urlencode(q, quote_via=urllib.parse.quote)}'
        return _request('GET', url, self.conn.username, self.conn.password)

    def _post(self, path, body):
        if not self.conn.configured:
            raise OneCError('not_configured')
        url = f'{self.conn.base_url}{_quote_path(path)}?$format=json'
        return _request('POST', url, self.conn.username, self.conn.password, body)

    def entity_sets(self):
        data = self._get('')
        return sorted({v.get('name') or v.get('url') for v in data.get('value', []) if v.get('name') or v.get('url')})

    def search(self, entity, query, fields=('Description', 'Code'), top=30):
        entity = check_entity(entity)
        q = str(query or '').strip()[:100]
        params = {'$top': str(int(top))}
        if q:
            conditions = [f'substringof({odata_string(q)}, {check_field(f)})' for f in fields]
            params['$filter'] = ' or '.join(conditions)
        if entity.startswith('Catalog_'):
            params['$filter'] = f"({params['$filter']}) and DeletionMark eq false" if '$filter' in params else 'DeletionMark eq false'
        if entity.startswith('Document_'):
            params['$orderby'] = 'Date desc'
        rows = self._get(entity, params).get('value', [])
        return [self._brief(entity, r) for r in rows]

    def record(self, entity, key):
        entity = check_entity(entity)
        if not GUID_RE.match(str(key)):
            raise OneCError('bad_key')
        row = self._get(f"{entity}(guid'{key}')")
        return {'brief': self._brief(entity, row), 'fields': self._plain_fields(row)}

    def documents_of(self, counterparty_key, top=20):
        entity = check_entity(self.conn.document_entity)
        field = check_field(self.conn.document_counterparty_field)
        if not GUID_RE.match(str(counterparty_key)):
            raise OneCError('bad_key')
        rows = self._get(entity, {'$filter': f"{field} eq guid'{counterparty_key}'", '$orderby': 'Date desc', '$top': str(top)}).get('value', [])
        return [self._brief(entity, r) for r in rows]

    def create_counterparty(self, name, inn='', comment=''):
        entity = check_entity(self.conn.counterparty_entity)
        body = {'Description': name}
        if inn:
            body[check_field(self.conn.inn_field)] = inn
        if comment:
            body['Комментарий'] = comment
        row = self._post(entity, body)
        return self._brief(entity, row)

    @staticmethod
    def _brief(entity, r):
        title = r.get('Description') or r.get('Number') or r.get('Code') or r.get('Ref_Key', '')
        subtitle = []
        if r.get('Number'):
            subtitle.append(f"№ {r['Number']}")
        if r.get('Date'):
            subtitle.append(str(r['Date'])[:10])
        if r.get('Code') and r.get('Description'):
            subtitle.append(str(r['Code']))
        for money in ('СуммаДокумента', 'Сумма', 'DocumentAmount'):
            if r.get(money) not in (None, ''):
                subtitle.append(f'{r[money]}')
                break
        if r.get('Posted') is True:
            subtitle.append('проведён')
        return {'key': r.get('Ref_Key', ''), 'entity': entity, 'title': str(title), 'subtitle': ' · '.join(map(str, subtitle))}

    @staticmethod
    def _plain_fields(row):
        out = []
        for k, v in row.items():
            if k.startswith('odata.') or k.endswith('@navigationLinkUrl') or isinstance(v, (dict, list)):
                continue
            if isinstance(v, str) and v == EMPTY_GUID:
                continue
            if v in (None, ''):
                continue
            out.append({'name': k, 'value': v})
        return out[:80]
