from importlib import import_module

from django.apps import apps as django_apps
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from sfera_auth.models import User
from sfera_modules.models import UserModule

from .models import MAX_DIARIES, Diary, DiaryAttachment, DiaryEntry


def app_client(user):
    client = APIClient(HTTP_X_IONIK_CLIENT='1')
    client.force_authenticate(user=user)
    return client


class DiaryApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='alice', password='x')
        self.client = app_client(self.user)

    def _create(self, name='Дневник'):
        return self.client.post('/api/diary/diaries/', {'name': name}, format='json')

    def test_limit_is_per_user_and_deleting_frees_a_slot(self):
        ids = [self._create(f'D{i}').json()['id'] for i in range(MAX_DIARIES)]
        self.assertEqual(self._create('extra').status_code, 409)
        self.assertEqual(app_client(User.objects.create_user(username='bob', password='x'))
                         .post('/api/diary/diaries/', {'name': 'mine'}, format='json').status_code, 201)
        self.assertEqual(self.client.delete(f'/api/diary/diaries/{ids[0]}/', {'password': 'bad'}, format='json').status_code, 403)
        self.assertEqual(self.client.delete(f'/api/diary/diaries/{ids[0]}/', {'password': 'x'}, format='json').status_code, 204)
        self.assertEqual(self._create('again').status_code, 201)

    def test_entries_text_rich_and_owner_only(self):
        did = self._create().json()['id']
        e = self.client.post(f'/api/diary/diaries/{did}/entries/', {'content': 'hi', 'tags': ['#a', 'a', 'b']}, format='json')
        self.assertEqual(e.status_code, 201)
        self.assertEqual(e.json()['tags'], ['a', 'b'])
        todo = self.client.post(f'/api/diary/diaries/{did}/rich/', {
            'type': 'todo', 'payload': {'title': 'T', 'items': ['one']},
        }, format='json').json()
        item = todo['payload']['items'][0]['id']
        toggled = self.client.post(f'/api/diary/entries/{todo["id"]}/todo/toggle/', {'item_id': item}, format='json')
        self.assertTrue(toggled.json()['todo']['items'][0]['done'])

        listed = self.client.get(f'/api/diary/diaries/{did}/entries/').json()
        self.assertEqual([x['id'] for x in listed], [e.json()['id'], todo['id']])

        stranger = app_client(User.objects.create_user(username='eve', password='x'))
        self.assertEqual(stranger.get(f'/api/diary/diaries/{did}/entries/').status_code, 404)
        self.assertEqual(stranger.delete(f'/api/diary/entries/{todo["id"]}/').status_code, 404)

    @override_settings(SFERA_MODULES_ENFORCE=True)
    def test_gated_by_install(self):
        self.assertEqual(self._create().status_code, 403)
        UserModule.objects.create(user=self.user, module_id='diary')
        self.assertEqual(self._create().status_code, 201)


class LegacyCopyTests(TestCase):
    """0002 copies Guild(is_private) diaries; 0003 drops the copied guilds."""

    def test_copy_then_drop(self):
        from sfera_messages.models import Guild, GuildAttachment, GuildChannel, GuildMembership, GuildMessage

        owner = User.objects.create_user(username='olga', password='x')
        g = Guild.objects.create(name='Old diary', owner=owner, is_personal_channel=True, is_private=True,
                                 is_discoverable=False)
        GuildMembership.objects.create(guild=g, user=owner, role='owner')
        ch = GuildChannel.objects.create(guild=g, name='feed', channel_type='text', position=0)
        m = GuildMessage(channel=ch, author=owner, tags=['x'])
        m.content = 'secret'
        m.save()
        GuildAttachment.objects.create(channel=ch, uploader=owner, message=m, file='attachments/f.enc',
                                       original_filename='f.txt', content_type='text/plain', file_size=3)
        server = Guild.objects.create(name='Real server', owner=owner)

        copy = import_module('sfera_diary.migrations.0002_copy_legacy_diaries')
        drop = import_module('sfera_diary.migrations.0003_drop_legacy_diary_guilds')
        copy.copy_diaries(django_apps, None)
        copy.copy_diaries(django_apps, None)  # idempotent

        d = Diary.objects.get()
        self.assertEqual((d.id, d.name, d.owner_id), (g.id, 'Old diary', owner.id))
        entry = DiaryEntry.objects.get()
        self.assertEqual((entry.id, entry.content, entry.tags), (m.id, 'secret', ['x']))
        self.assertEqual(DiaryAttachment.objects.get().entry_id, m.id)
        self.assertTrue(UserModule.objects.filter(user=owner, module_id='diary').exists())

        drop.drop_legacy(django_apps, None)
        self.assertFalse(Guild.objects.filter(id=g.id).exists())
        self.assertTrue(Guild.objects.filter(id=server.id).exists())
        self.assertEqual(DiaryAttachment.objects.get().file.name, 'attachments/f.enc')
