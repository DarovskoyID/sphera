"""Opt-in SQL controller for immutable v2 generations, four status changes each.

Prepared generations are completed exactly after restart. SQL disappearance
never removes a previously committed UUID; partial generations do not authorize
fanout until the entire current SQL snapshot agrees with the committed index.
"""
from hashlib import sha256
import json
import time
import sqlite3

from django.conf import settings

from sfera_mesh.directory import digest64, ZERO
from sfera_mesh.recovery_pages import PagedIndexReader, context, validate_index, validate_page, entry as validate_entry
from sfera_mesh.recovery_roots import namespace
from sfera_mesh.recovery_tree import RecoveryTree, validate_head
from sfera_mesh.storage import canonical
from .encryption import encrypt_bytes, decrypt_bytes
from .mesh_index_worker import AutomaticIndexes, snapshot, fingerprint
from .mesh_paged_publication import PagedIndexPublication, FIELDS
from .mesh_read import fetch_ciphertext
from .mesh_index_cleanup import prune_generations
from .mesh_index_budget import family_budget, is_full


def page_clusters():
    values = getattr(settings, 'SFERA_MESH_MESSAGE_INDEX_PAGE_CLUSTERS', [])
    if (not isinstance(values, (list, tuple)) or not 1 <= len(values) <= 128 or
            any(not digest64(value) for value in values) or len(set(values)) != len(values)):
        raise ValueError('paged_index_page_clusters_required')
    return list(values)


def document_only(value):
    return {key: item for key, item in value.items() if key != '_previous_messages'}


def content(value):
    return fingerprint(document_only(value))


class AutomaticPagedIndexes(AutomaticIndexes):
    def __init__(self, path, writer, *, using='default'):
        self.clusters = page_clusters()
        super().__init__(path, writer, using=using)

    def _stored(self, identity):
        stored = super()._stored(identity)
        if stored is not None:
            document = stored[0]
            if (set(document) != FIELDS | {'_previous_messages'} or
                    document['domain'] != 'sfera-mesh-message-index-input-v2' or
                    not isinstance(document['_previous_messages'], dict) or
                    any(type(value) is not bool for value in document['_previous_messages'].values())):
                raise ValueError('paged_index_controller_corrupt')
            previous = document['_previous_messages']
            RecoveryTree(previous, [identity for identity, deleted in previous.items() if deleted])
            ids = []
            for entry in document['entries']:
                validate_entry(entry); ids.append(entry['message_id'])
            if ids != sorted(set(ids)):
                raise ValueError('paged_index_controller_corrupt')
        return stored

    def _head(self, identity):
        directory = self.writer.publication.directory
        with directory.lock:
            directory.anchor()
            if identity in directory.current['state'].get('recovery_roots', {}) and identity not in directory.current['state'].get('recovery_trees', {}):
                raise ValueError('paged_index_legacy_migration_requires_operator')
            head = directory.current['state'].get('recovery_trees', {}).get(identity)
            if head is not None:
                head = json.loads(canonical(head))
                body, digest = validate_head(head['record'], directory.network, directory.pin)
                if digest != head['digest'] or namespace(body['publisher'], body['source'], body['scope']) != identity or body['publisher'] != self.publisher:
                    raise ValueError('paged_index_controller_head_changed')
            return head

    def _matches(self, document, head):
        if head is None: return False
        body = head['record']['body']
        tree = RecoveryTree([entry['message_id'] for entry in document['entries']],
            [entry['message_id'] for entry in document['entries'] if entry['deleted']])
        return (document['generation'], document['previous'], document['genesis'], document['publisher'],
            document['source'], document['scope'], tree.root, len(document['entries']), sum(entry['deleted'] for entry in document['entries'])) == (
            body['version'], body['previous'], body['genesis'], body['publisher'], body['source'], body['scope'], body['root'], body['count'], body['deleted_count'])

    def _recover(self, head):
        """Rebuild lost controller metadata from the current authenticated pages."""
        body = head['record']['body']; deadline = time.monotonic() + 15
        used, seen, entries = 0, set(), []
        self.writer.publication.journal.refresh_discovery()
        from sfera_mesh.manifest_reads import verified_manifests
        with self.writer.publication.directory.lock:
            _, known = verified_manifests(self.writer.publication.directory)
        def load(ref):
            nonlocal used
            key = ref['cluster'], ref['digest']
            if key in seen or used + ref['size'] > 32 * 1048576 or time.monotonic() >= deadline:
                raise ValueError('paged_index_controller_recovery_limit')
            seen.add(key); used += ref['size']
            if known.get(ref['cluster'], {}).get('sizes', {}).get(ref['digest']) != ref['size']:
                raise ValueError('paged_index_controller_page_uncommitted')
            data = fetch_ciphertext(self.writer, ref['cluster'], ref['digest'], ref['size'], deadline)
            return PagedIndexReader.unpack(canonical([data.hex()]), ref, decrypt_bytes)
        doc = load(body); validate_index(doc, body)
        def visit(ref):
            page = validate_page(load(ref), ref, context(body)); entries.extend(page['entries'])
            for child in page['children']: visit(child)
        if doc['page'] is not None: visit(doc['page'])
        from sfera_mesh.recovery_timeline import validate_complete
        validate_complete(doc, entries, load)
        result = {'domain': 'sfera-mesh-message-index-input-v2', **{key: body[key] for key in ('genesis', 'publisher', 'source', 'scope')},
            'cluster': self.clusters[0], 'page_clusters': self.clusters, 'generation': body['version'], 'previous': body['previous'],
            **{key: doc[key] for key in ('members', 'guild_id', 'public', 'closed')}, 'entries': entries, '_previous_messages': {}}
        if not self._matches(result, head): raise ValueError('paged_index_controller_recovery_mismatch')
        if time.monotonic() >= deadline: raise ValueError('paged_index_controller_recovery_limit')
        return result

    def _save(self, identity, document, root_hash=None):
        raw = canonical(document)
        if len(raw) > 32 * 1048576: raise ValueError('paged_index_controller_byte_limit')
        if root_hash is None: family_budget(self, document)
        try:
            with self.db:
                self.db.execute('INSERT OR REPLACE INTO automatic_index_scopes VALUES(?,?,?,?)',
                    (identity, encrypt_bytes(raw), fingerprint(document), root_hash))
        except sqlite3.OperationalError as exc:
            if is_full(exc): raise ValueError('paged_index_controller_disk_budget_exhausted') from exc
            raise

    def _desired(self, source, scope, baseline):
        desired, sizes = snapshot(self.writer, source, scope, using=self.using, paged=True, page_clusters=self.clusters)
        for cluster, values in sizes.items():
            self.writer.confirm_sizes(cluster, values)
        old = {entry['message_id']: entry for entry in baseline['entries']} if baseline else {}
        current = {entry['message_id']: entry for entry in desired['entries']}
        if any(entry['deleted'] and identity in current and not current[identity]['deleted'] for identity, entry in old.items()):
            raise ValueError('paged_index_omission_or_resurrection')
        # Preserve known data when source/outbox rows are lost. Only explicit,
        # validated terminal tombstones change the status to deleted.
        desired['entries'] = [entry for _, entry in sorted({**old, **current}.items())]
        return desired, sizes

    def allows(self, write):
        identity = namespace(self.publisher, write.source, str(write.conversation_id))
        stored = self._stored(identity)
        if stored is None or stored[2] is None: return False
        document, _, digest = stored
        head = self._head(identity)
        if head is None or head['digest'] != digest or not self._matches(document, head): return False
        desired, _ = self._desired(write.source, str(write.conversation_id), document)
        latest = self._head(identity)
        return latest is not None and latest['digest'] == digest and content(desired) == content(document) and any(entry['message_id'] == str(write.message_id) and
            entry['snapshot_hash'] == write.snapshot_hash for entry in document['entries'])

    def _scope_step(self, identity, source, scope):
        stored = self._stored(identity); head = self._head(identity)
        if stored is not None and stored[2] is None:
            # Do not recapture SQL or rebase a prepared generation on retry.
            document = stored[0]
        else:
            baseline = stored[0] if stored else self._recover(head) if head else None
            if stored and (head is None or head['digest'] != stored[2] or not self._matches(baseline, head)):
                raise ValueError('paged_index_confirmed_root_changed')
            cleanup = prune_generations(self, identity, head['digest']) if stored else None
            desired, _ = self._desired(source, scope, baseline)
            if baseline is not None and content(desired) == content(baseline):
                latest = self._head(identity)
                if latest is None or latest['digest'] != head['digest']:
                    raise ValueError('paged_index_confirmed_root_changed')
                if not stored: self._save(identity, baseline, head['digest'])
                if cleanup is None: cleanup = prune_generations(self, identity, head['digest'])
                return {'state': 'confirmed', 'root_hash': head['digest'], 'cleanup': cleanup}
            previous = {entry['message_id']: entry['deleted'] for entry in baseline['entries']} if baseline else {}
            changed = [entry['message_id'] for entry in desired['entries'] if entry['message_id'] not in previous or
                previous[entry['message_id']] != entry['deleted']]
            changed_set = set(changed)
            accepted = set(changed[:4])
            old = {entry['message_id']: entry for entry in baseline['entries']} if baseline else {}
            values = {entry['message_id']: entry for entry in desired['entries'] if entry['message_id'] not in changed_set or entry['message_id'] in accepted}
            values.update({identity: entry for identity, entry in old.items() if identity in changed_set and identity not in accepted})
            document = {**desired, 'entries': [entry for _, entry in sorted(values.items())],
                'generation': head['record']['body']['version'] + 1 if head else 1,
                'previous': head['digest'] if head else ZERO, '_previous_messages': previous}
            self._save(identity, document)
        job = PagedIndexPublication(self._job(document), self.writer, document_only(document),
            previous_messages=document['_previous_messages'], cache_path=self.path + '.page-cache.sqlite')
        try:
            status = job.step()
            if status['state'] == 'confirmed':
                head = self._head(identity)
                if head is None or head['digest'] != status['root_hash'] or head['record']['body'] != job.target:
                    raise ValueError('paged_index_confirmation_mismatch')
                self._save(identity, document, head['digest'])
                status['cleanup'] = prune_generations(self, identity, head['digest'])
                desired, _ = self._desired(source, scope, document)
                if content(desired) != content(document):
                    return {'state': 'waiting', 'phase': 'remaining_changes', 'root_hash': head['digest'], 'cleanup': status['cleanup']}
            return status
        finally: job.close()

    def step(self, *, limit=8):
        from .models import MessageMeshWrite
        if type(limit) is not int or not 1 <= limit <= 16: raise ValueError('invalid_automatic_index_batch')
        directory = self.writer.publication.directory
        directory.refresh(self.writer.publication.address)
        with directory.lock:
            directory.anchor()
            heads = json.loads(canonical(directory.current['state'].get('recovery_trees', {})))
        scopes = {(source, str(scope)) for source, scope in MessageMeshWrite.objects.using(self.using)
            .values_list('source', 'conversation_id').distinct()[:129]}
        scopes.update((head['record']['body']['source'], head['record']['body']['scope']) for head in heads.values()
            if head['record']['body']['publisher'] == self.publisher)
        scopes.update((self._stored(identity)[0]['source'], self._stored(identity)[0]['scope']) for (identity,) in
            self.db.execute('SELECT identity FROM automatic_index_scopes').fetchall())
        if len(scopes) > 128: raise ValueError('automatic_index_scope_limit')
        ordered = sorted((namespace(self.publisher, source, scope), source, scope) for source, scope in scopes)
        cursor = self.db.execute('SELECT cursor FROM automatic_index_pin').fetchone()[0]
        selected = ([row for row in ordered if row[0] > cursor] + [row for row in ordered if row[0] <= cursor])[:limit]
        result = []
        for identity, source, scope in selected:
            try:
                result.append({'source': source, 'scope': scope, **self._scope_step(identity, source, scope)})
            except ValueError as exc:
                result.append({'source': source, 'scope': scope, 'state': 'waiting', 'error': str(exc)[:96]})
            finally:
                with self.db: self.db.execute('UPDATE automatic_index_pin SET cursor=?', (identity,))
        return result
