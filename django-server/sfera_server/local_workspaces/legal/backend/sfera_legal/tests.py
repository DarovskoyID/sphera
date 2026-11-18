import json
from datetime import timedelta

from django.core import mail
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from sfera_auth.models import User
from sfera_messages.models import Conversation, ConversationParticipant, Message

from . import chain
from .models import ChainEntry, LegalSettings, Package, SignCode, Signature


def app_client(user=None):
    c = APIClient(HTTP_X_IONIK_CLIENT='1')
    if user:
        c.force_authenticate(user=user)
    return c


def make_message(conv, author, text, at=None):
    m = Message(conversation=conv, author=author)
    m.content = text
    m.save()
    if at:
        Message.objects.filter(id=m.id).update(created_at=at)
        m.refresh_from_db()
    return m


class ChainTests(TestCase):
    def setUp(self):
        self.alice = User.objects.create_user(username='alice', password='x')
        self.bob = User.objects.create_user(username='bob', password='x')
        self.conv = Conversation.objects.create()
        for u in (self.alice, self.bob):
            ConversationParticipant.objects.create(conversation=self.conv, user=u)
        self.scope = chain.dm_scope(self.conv.id)
        LegalSettings.objects.create(record_chain=True)
        chain.forget_settings()

    def link(self, text, at=None):
        m = make_message(self.conv, self.alice, text, at)
        chain.flush([{
            'scope': self.scope, 'message_id': str(m.id), 'author_id': str(self.alice.id),
            'sent_at': m.created_at,
            'content_hash': chain.content_hash(message_id=m.id, author_id=self.alice.id, sent_at=m.created_at, text=text),
        }])
        return m

    def test_links_follow_each_other_and_verify(self):
        for i in range(3):
            self.link(f'сообщение {i}')
        rows = list(ChainEntry.objects.filter(scope=self.scope).order_by('seq'))
        self.assertEqual([r.seq for r in rows], [1, 2, 3])
        self.assertEqual(rows[1].prev_hash, rows[0].chain_hash)
        self.assertEqual(chain.verify(self.scope)[0], True)

    def test_a_changed_message_breaks_the_chain(self):
        self.link('первое')
        row = ChainEntry.objects.get(scope=self.scope, seq=1)
        row.content_hash = chain.sha256('подделка')
        row.save(update_fields=['content_hash'])
        ok, note = chain.verify(self.scope)
        self.assertFalse(ok)
        self.assertIn('№1', note)

    def test_a_removed_link_is_noticed(self):
        for i in range(3):
            self.link(f'm{i}')
        ChainEntry.objects.filter(scope=self.scope, seq=2).delete()
        ok, note = chain.verify(self.scope)
        self.assertFalse(ok)
        self.assertIn('№2', note)

    def test_same_message_twice_does_not_duplicate(self):
        m = self.link('один раз')
        before = ChainEntry.objects.count()
        chain.flush([{
            'scope': self.scope, 'message_id': str(m.id), 'author_id': str(self.alice.id),
            'sent_at': m.created_at, 'content_hash': 'x' * 64,
        }])
        self.assertEqual(ChainEntry.objects.count(), before)
        self.assertEqual(chain.verify(self.scope)[0], True)

    def test_recording_is_off_until_enabled(self):
        LegalSettings.objects.update(record_chain=False)
        chain.forget_settings()
        self.assertFalse(chain.recording_enabled())


class ProtocolApiTests(TestCase):
    def setUp(self):
        self.alice = User.objects.create_user(username='alice', email='alice@x.ru', password='x')
        self.bob = User.objects.create_user(username='bob', email='bob@x.ru', password='x')
        self.stranger = User.objects.create_user(username='eve', email='eve@x.ru', password='x')
        self.conv = Conversation.objects.create()
        for u in (self.alice, self.bob):
            ConversationParticipant.objects.create(conversation=self.conv, user=u)
        self.scope = f'dm:{self.conv.id}'
        self.a, self.b, self.e = app_client(self.alice), app_client(self.bob), app_client(self.stranger)
        LegalSettings.objects.create(record_chain=True, org_name='ООО «Ромашка»')
        chain.forget_settings()
        now = timezone.now()
        for i in range(3):
            m = make_message(self.conv, self.alice if i % 2 == 0 else self.bob, f'сообщение {i}', now - timedelta(minutes=10 - i))
            chain.flush([{
                'scope': self.scope, 'message_id': str(m.id), 'author_id': str(m.author_id), 'sent_at': m.created_at,
                'content_hash': chain.content_hash(message_id=m.id, author_id=m.author_id, sent_at=m.created_at, text=m.content),
            }])

    def create(self, client=None):
        r = (client or self.a).post('/api/legal/packages/', {'scope': self.scope, 'title': 'Спор по поставке'}, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def test_only_participants_can_build_a_protocol(self):
        self.assertEqual(self.e.post('/api/legal/packages/', {'scope': self.scope}, format='json').status_code, 404)
        self.create()

    def test_seal_freezes_messages_and_hashes_them(self):
        p = self.create()
        sealed = self.a.post(f"/api/legal/packages/{p['id']}/seal/").json()
        self.assertEqual(sealed['status'], 'sealed')
        self.assertEqual(sealed['message_count'], 3)
        self.assertTrue(sealed['chain_ok'])
        self.assertEqual(len(sealed['content_hash']), 64)
        # Messages written after sealing do not change the protocol.
        make_message(self.conv, self.alice, 'после протокола')
        again = self.a.get(f"/api/legal/packages/{p['id']}/").json()
        self.assertEqual(again['content_hash'], sealed['content_hash'])
        self.assertEqual(again['message_count'], 3)
        snapshot = json.loads(self.a.get(f"/api/legal/packages/{p['id']}/download/json/").content)
        self.assertEqual([m['text'] for m in snapshot['messages']], ['сообщение 0', 'сообщение 1', 'сообщение 2'])
        self.assertEqual(self.a.post(f"/api/legal/packages/{p['id']}/seal/").status_code, 409)

    def test_protocol_reports_a_broken_chain(self):
        ChainEntry.objects.filter(scope=self.scope, seq=2).delete()
        p = self.create()
        sealed = self.a.post(f"/api/legal/packages/{p['id']}/seal/").json()
        self.assertFalse(sealed['chain_ok'])
        self.assertIn('№2', sealed['chain_note'])

    def test_sign_with_a_code_from_email(self):
        p = self.create()
        self.a.post(f"/api/legal/packages/{p['id']}/seal/")
        self.assertEqual(self.b.post(f"/api/legal/packages/{p['id']}/sign/", {'code': '000000'}, format='json').status_code, 400)
        self.assertEqual(self.b.post(f"/api/legal/packages/{p['id']}/code/").status_code, 200)
        self.assertEqual(len(mail.outbox), 1)
        code = SignCode.objects.get(email='bob@x.ru').code
        self.assertIn(code, mail.outbox[0].body)
        signed = self.b.post(f"/api/legal/packages/{p['id']}/sign/", {'code': code}, format='json')
        self.assertEqual(signed.status_code, 201, signed.content)
        self.assertTrue(signed.json()['matches_protocol'])
        self.assertEqual(self.b.post(f"/api/legal/packages/{p['id']}/sign/", {'code': code}, format='json').status_code, 409)
        self.assertFalse(SignCode.objects.filter(email='bob@x.ru').exists())

    def test_sign_by_uploading_a_signature_file(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        p = self.create()
        self.a.post(f"/api/legal/packages/{p['id']}/seal/")
        upload = SimpleUploadedFile('protocol.sig', b'\x30\x80 not a real CMS', content_type='application/pkcs7-signature')
        r = self.b.post(f"/api/legal/packages/{p['id']}/sign/", {'signature': upload}, format='multipart')
        self.assertEqual(r.status_code, 201, r.content)
        s = Signature.objects.get(package_id=p['id'])
        self.assertEqual(s.method, 'file')
        self.assertTrue(s.file)
        self.assertIn('экспертом', s.note)

    def test_public_verification_shows_no_content(self):
        p = self.create()
        sealed = self.a.post(f"/api/legal/packages/{p['id']}/seal/").json()
        anon = app_client()
        r = anon.get(f"/api/legal/public/verify/{sealed['code']}/?hash={sealed['content_hash']}")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body['hash_matches'])
        self.assertEqual(body['message_count'], 3)
        self.assertNotIn('сообщение', json.dumps(body, ensure_ascii=False))
        self.assertFalse(anon.get(f"/api/legal/public/verify/{sealed['code']}/?hash=deadbeef").json()['hash_matches'])
        self.assertEqual(anon.get('/api/legal/public/verify/AAAA-BBBB-CCCC/').status_code, 404)

    def test_printable_protocol_contains_the_messages_and_hash(self):
        p = self.create()
        sealed = self.a.post(f"/api/legal/packages/{p['id']}/seal/").json()
        page = self.a.get(f"/api/legal/packages/{p['id']}/download/html/").content.decode()
        self.assertIn('Протокол переписки', page)
        self.assertIn('сообщение 1', page)
        self.assertIn(sealed['content_hash'], page)
        self.assertIn('ООО «Ромашка»', page)

    def test_stranger_sees_nothing(self):
        p = self.create()
        self.a.post(f"/api/legal/packages/{p['id']}/seal/")
        self.assertEqual(self.e.get(f"/api/legal/packages/{p['id']}/").status_code, 404)
        self.assertEqual(self.e.get('/api/legal/packages/').json(), [])
        self.assertEqual(len(self.b.get('/api/legal/packages/').json()), 1)

    def test_only_superuser_changes_settings(self):
        self.assertEqual(self.a.get('/api/legal/settings/').status_code, 403)
        root = User.objects.create_superuser(username='root', email='r@x.ru', password='x')
        r = app_client(root).put('/api/legal/settings/', {'record_chain': True, 'tsa_url': 'ftp://nope'}, format='json')
        self.assertEqual(r.status_code, 400)
