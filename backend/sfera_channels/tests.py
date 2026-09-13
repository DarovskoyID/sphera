from datetime import timedelta
from importlib import import_module

from django.apps import apps as django_apps
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from sfera_auth.models import User
from sfera_modules.models import UserModule

from .models import MAX_OWNED_CHANNELS, Channel, Post, PostComment, ScheduledPost, Subscription
from .services import deliver_due


def app_client(user):
    client = APIClient(HTTP_X_IONIK_CLIENT='1')
    client.force_authenticate(user=user)
    return client


class ChannelApiTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username='olga', password='x')
        self.reader = User.objects.create_user(username='ivan', password='x')
        self.o = app_client(self.owner)
        self.r = app_client(self.reader)

    def _channel(self, name='Лента', **extra):
        res = self.o.post('/api/channels/', {'name': name, **extra}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.json()

    def test_owner_limit(self):
        for i in range(MAX_OWNED_CHANNELS):
            self._channel(f'c{i}')
        self.assertEqual(self.o.post('/api/channels/', {'name': 'extra'}, format='json').status_code, 409)

    def test_subscribe_post_react_comment_flow(self):
        ch = self._channel()
        self.assertEqual(self.r.post('/api/channels/join/', {'invite_code': ch['invite_code']}, format='json').status_code, 201)
        self.assertEqual(self.r.post(f'/api/channels/{ch["id"]}/posts/', {'content': 'nope'}, format='json').status_code, 403)

        post = self.o.post(f'/api/channels/{ch["id"]}/posts/', {'content': 'hello #news'}, format='json').json()
        feed = self.r.get(f'/api/channels/{ch["id"]}/posts/').json()
        self.assertEqual([p['id'] for p in feed], [post['id']])

        react = self.r.post(f'/api/channels/posts/{post["id"]}/reactions/', {'emoji': '🔥'}, format='json').json()
        self.assertEqual(react['reactions'], [{'emoji': '🔥', 'count': 1, 'me': True}])
        self.assertEqual(self.r.post(f'/api/channels/posts/{post["id"]}/view/').json()['views'], 1)

        comment = self.r.post(f'/api/channels/posts/{post["id"]}/comments/', {'content': 'nice'}, format='json')
        self.assertEqual(comment.status_code, 201)
        self.o.patch(f'/api/channels/{ch["id"]}/', {'comments_enabled': False}, format='json')
        self.assertEqual(self.r.post(f'/api/channels/posts/{post["id"]}/comments/', {'content': 'x'}, format='json').status_code, 403)
        # Only the comment's author may delete it.
        self.assertEqual(self.o.delete(f'/api/channels/comments/{comment.json()["id"]}/').status_code, 404)
        self.assertEqual(self.r.delete(f'/api/channels/comments/{comment.json()["id"]}/').status_code, 204)

        listed = self.r.get('/api/channels/').json()
        self.assertEqual(listed[0]['subscriber_count'], 2)
        self.assertEqual(self.r.delete(f'/api/channels/{ch["id"]}/leave/').status_code, 204)
        self.assertEqual(self.o.delete(f'/api/channels/{ch["id"]}/leave/').status_code, 400)

    def test_hidden_channel_is_invisible_to_strangers(self):
        ch = self._channel()
        self.o.patch(f'/api/channels/{ch["id"]}/', {'is_discoverable': False}, format='json')
        self.assertEqual(self.r.get(f'/api/channels/{ch["id"]}/posts/').status_code, 404)
        self.assertEqual(self.r.get('/api/channels/explore/').json(), [])
        self.assertEqual(self.r.post('/api/channels/join/', {'channel_id': ch['id']}, format='json').status_code, 404)

    def test_delete_requires_password(self):
        ch = self._channel()
        self.assertEqual(self.o.delete(f'/api/channels/{ch["id"]}/', {'password': 'bad'}, format='json').status_code, 403)
        self.assertEqual(self.o.delete(f'/api/channels/{ch["id"]}/', {'password': 'x'}, format='json').status_code, 204)
        self.assertFalse(Channel.objects.exists())

    def test_scheduled_post_is_delivered_when_due(self):
        ch = self._channel()
        res = self.o.post(f'/api/channels/{ch["id"]}/schedule/', {'content': 'later', 'delay_seconds': 60}, format='json')
        self.assertEqual(res.status_code, 201)
        self.assertEqual(deliver_due(), [])
        ScheduledPost.objects.update(send_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(len(self.o.get(f'/api/channels/{ch["id"]}/posts/').json()), 1)
        self.assertEqual(deliver_due(), [])

    @override_settings(SFERA_MODULES_ENFORCE=True)
    def test_gated_by_install(self):
        self.assertEqual(self.o.post('/api/channels/', {'name': 'x'}, format='json').status_code, 403)
        UserModule.objects.create(user=self.owner, module_id='channels')
        self.assertEqual(self.o.post('/api/channels/', {'name': 'x'}, format='json').status_code, 201)


class LegacyCopyTests(TestCase):
    def test_copy_then_drop(self):
        from sfera_messages.models import (
            Guild, GuildChannel, GuildMembership, GuildMessage, GuildMessageReaction, GuildPostComment,
        )

        owner = User.objects.create_user(username='olga', password='x')
        reader = User.objects.create_user(username='ivan', password='x')
        g = Guild.objects.create(name='Old feed', owner=owner, is_personal_channel=True, tags=['a'])
        GuildMembership.objects.create(guild=g, user=owner, role='owner')
        GuildMembership.objects.create(guild=g, user=reader, notifications_muted=True)
        feed = GuildChannel.objects.create(guild=g, name='feed', channel_type='text', position=0)
        m = GuildMessage(channel=feed, author=owner)
        m.content = 'first post'
        m.save()
        old = timezone.now() - timedelta(days=30)
        GuildMessage.objects.filter(id=m.id).update(created_at=old)
        GuildMessageReaction.objects.create(message=m, user=reader, emoji='👍')
        c = GuildPostComment(message=m, author=reader)
        c.content = 'hi'
        c.save()
        server = Guild.objects.create(name='Real server', owner=owner)

        copy = import_module('sfera_channels.migrations.0003_copy_legacy_channels')
        drop = import_module('sfera_channels.migrations.0004_drop_legacy_channel_guilds')
        copy.copy_channels(django_apps, None)
        copy.copy_channels(django_apps, None)

        ch = Channel.objects.get()
        self.assertEqual((ch.id, ch.name, ch.invite_code, ch.tags), (g.id, 'Old feed', g.invite_code, ['a']))
        self.assertEqual(Subscription.objects.get(user=reader).notifications_muted, True)
        self.assertEqual(Subscription.objects.get(user=owner).role, 'owner')
        post = Post.objects.get()
        self.assertEqual((post.id, post.content), (m.id, 'first post'))
        self.assertLess(abs((post.created_at - old).total_seconds()), 1)
        self.assertEqual(PostComment.objects.get().content, 'hi')
        self.assertEqual(set(UserModule.objects.values_list('user__username', flat=True)), {'olga', 'ivan'})

        drop.drop_legacy(django_apps, None)
        self.assertFalse(Guild.objects.filter(id=g.id).exists())
        self.assertTrue(Guild.objects.filter(id=server.id).exists())
        # auto_now_add is restored after the copy.
        self.assertTrue(Post._meta.get_field('created_at').auto_now_add)
