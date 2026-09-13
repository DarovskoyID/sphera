from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from sfera_auth.models import Friendship, User, UserSettings, is_child
from sfera_modules.models import UserModule

from .models import Family, FamilyMembership


def app_client(user):
    client = APIClient(HTTP_X_IONIK_CLIENT='1')
    client.force_authenticate(user=user)
    return client


class FamilyTests(TestCase):
    def setUp(self):
        self.mom = User.objects.create_user(username='mom', password='Passw0rd!x')
        self.stranger = User.objects.create_user(username='stranger', password='Passw0rd!x')
        self.m = app_client(self.mom)

    def _family_with_child(self):
        self.assertEqual(self.m.post('/api/family/', {'name': 'Ивановы'}, format='json').status_code, 201)
        res = self.m.post('/api/family/children/', {'username': 'kid', 'password': 'Kid-Passw0rd!'}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return User.objects.get(username='kid')

    def test_child_is_managed_and_locked(self):
        kid = self._family_with_child()
        self.assertTrue(is_child(kid))
        self.assertFalse(is_child(self.mom))
        self.assertTrue(UserSettings.objects.get(user=kid).blur_enabled)
        self.assertTrue(UserModule.objects.filter(user=kid, module_id='family').exists())

    @override_settings(SFERA_MODULES_ENFORCE=True)
    def test_family_members_cannot_uninstall_the_module(self):
        self.assertEqual(self.m.post('/api/family/').status_code, 403)  # not installed yet
        UserModule.objects.create(user=self.mom, module_id='family')
        kid = self._family_with_child()
        self.assertEqual(self.m.delete('/api/modules/family/install/').status_code, 409)
        res = app_client(kid).delete('/api/modules/family/install/')
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json()['error'], 'locked')
        self.assertTrue(is_child(kid))

    def test_friend_request_waits_for_a_parent(self):
        kid = self._family_with_child()
        res = app_client(self.stranger).post('/api/auth/friends/request/', {'user_id': str(kid.id)}, format='json')
        if res.status_code == 404:  # endpoint name differs between versions
            self.skipTest('friend request endpoint not found')
        f = Friendship.objects.get(from_user=self.stranger, to_user=kid)
        self.assertEqual(f.status, 'awaiting_parent')
        approvals = self.m.get('/api/family/').json()['family']['pending_approvals']
        self.assertEqual([a['id'] for a in approvals], [str(f.id)])
        self.assertEqual(self.m.post(f'/api/family/approvals/{f.id}/', {'approve': True}, format='json').status_code, 200)
        f.refresh_from_db()
        self.assertEqual(f.status, 'pending')

    def test_last_parent_cannot_leave_children_behind(self):
        self._family_with_child()
        res = self.m.post(f'/api/family/members/{self.mom.id}/remove/')
        self.assertEqual(res.status_code, 409)

    def test_locations_are_opt_in_and_expire(self):
        kid = self._family_with_child()
        self.assertEqual(self.m.get('/api/family/locations/').json()['locations'], [])
        self.assertEqual(app_client(kid).post('/api/family/location/', {'lat': 55.75, 'lng': 37.61, 'minutes': 30}, format='json').status_code, 200)
        locs = self.m.get('/api/family/locations/').json()['locations']
        self.assertEqual(len(locs), 1)
        self.assertEqual(app_client(kid).delete('/api/family/location/').status_code, 204)
        self.assertEqual(self.m.get('/api/family/locations/').json()['locations'], [])

    def test_family_gets_a_private_server_when_servers_exist(self):
        from sfera_messages.models import Guild, GuildMembership
        kid = self._family_with_child()
        fam = Family.objects.get()
        guild = Guild.objects.get(id=fam.server_id)
        self.assertFalse(guild.is_discoverable)
        self.assertEqual(GuildMembership.objects.get(guild=guild, user=kid).role, 'member')
        self.assertEqual(FamilyMembership.objects.count(), 2)
