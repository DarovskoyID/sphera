from datetime import timedelta

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from sfera_auth.models import User

from .models import Task


def app_client(user):
    client = APIClient(HTTP_X_IONIK_CLIENT='1')
    client.force_authenticate(user=user)
    return client


class PlannerTests(TestCase):
    def setUp(self):
        self.alice = User.objects.create_user(username='alice', password='x')
        self.bob = User.objects.create_user(username='bob', password='x')
        self.a = app_client(self.alice)
        self.b = app_client(self.bob)
        r = self.a.post('/api/planner/projects/', {'name': 'Релиз'}, format='json')
        self.assertEqual(r.status_code, 201)
        self.project = r.json()
        self.todo, self.doing, self.done = [c['id'] for c in self.project['columns']]
        self.pid = self.project['id']

    def test_members_only_and_viewer_is_read_only(self):
        self.assertEqual(self.b.get(f'/api/planner/projects/{self.pid}/').status_code, 404)
        self.a.post(f'/api/planner/projects/{self.pid}/members/', {'user_id': str(self.bob.id), 'role': 'viewer'}, format='json')
        self.assertEqual(self.b.get(f'/api/planner/projects/{self.pid}/').status_code, 200)
        r = self.b.post(f'/api/planner/projects/{self.pid}/tasks/', {'title': 'x'}, format='json')
        self.assertEqual(r.status_code, 403)
        self.a.patch(f'/api/planner/projects/{self.pid}/members/{self.bob.id}/', {'role': 'editor'}, format='json')
        r = self.b.post(f'/api/planner/projects/{self.pid}/tasks/', {'title': 'x'}, format='json')
        self.assertEqual(r.status_code, 201)
        # Bob may leave, but not remove the owner.
        self.assertEqual(self.b.delete(f'/api/planner/projects/{self.pid}/members/{self.alice.id}/').status_code, 403)
        self.assertEqual(self.b.delete(f'/api/planner/projects/{self.pid}/members/{self.bob.id}/').status_code, 204)

    def test_task_lifecycle_assignees_and_completion(self):
        r = self.a.post(f'/api/planner/projects/{self.pid}/tasks/', {
            'title': 'Написать тесты', 'priority': 3, 'labels': ['qa', 'qa', ' '],
            'checklist': [{'text': 'unit'}, {'text': ''}],
            'assignee_ids': [str(self.alice.id), str(self.bob.id)],  # bob is not a member
        }, format='json')
        self.assertEqual(r.status_code, 201)
        t = r.json()
        self.assertEqual(t['labels'], ['qa'])
        self.assertEqual(len(t['checklist']), 1)
        self.assertEqual([u['id'] for u in t['assignees']], [str(self.alice.id)])
        self.assertEqual(t['column_id'], self.todo)

        r = self.a.patch(f'/api/planner/tasks/{t["id"]}/', {'column_id': self.done}, format='json')
        self.assertIsNotNone(r.json()['completed_at'])
        r = self.a.patch(f'/api/planner/tasks/{t["id"]}/', {'column_id': self.doing}, format='json')
        self.assertIsNone(r.json()['completed_at'])
        r = self.a.patch(f'/api/planner/tasks/{t["id"]}/', {'done': True}, format='json')
        self.assertEqual(r.json()['column_id'], self.done)
        r = self.a.patch(f'/api/planner/tasks/{t["id"]}/', {'done': False}, format='json')
        self.assertEqual(r.json()['column_id'], self.todo)
        self.assertEqual(len(self.a.get('/api/planner/my/').json()), 1)

    def test_recurring_task_comes_back(self):
        due = timezone.now().replace(microsecond=0)
        t = self.a.post(f'/api/planner/projects/{self.pid}/tasks/', {
            'title': 'Отчёт', 'due_at': due.isoformat(), 'recurrence': 'weekly',
        }, format='json').json()
        r = self.a.patch(f'/api/planner/tasks/{t["id"]}/', {'column_id': self.done}, format='json').json()
        self.assertIn('next', r)
        self.assertEqual(r['next']['column_id'], self.todo)
        self.assertEqual(Task.objects.get(id=r['next']['id']).due_at, due + timedelta(weeks=1))
        self.assertEqual(Task.objects.count(), 2)

    def test_reminder_is_delivered_once(self):
        due = timezone.now() + timedelta(minutes=10)
        self.a.post(f'/api/planner/projects/{self.pid}/tasks/', {
            'title': 'Созвон', 'due_at': due.isoformat(), 'reminder_minutes': 15,
            'assignee_ids': [str(self.alice.id)],
        }, format='json')
        self.assertEqual(len(self.a.post('/api/planner/reminders/').json()), 1)
        self.assertEqual(self.a.post('/api/planner/reminders/').json(), [])

    def test_deleting_a_column_keeps_its_tasks(self):
        t = self.a.post(f'/api/planner/projects/{self.pid}/tasks/', {'title': 'a', 'column_id': self.doing}, format='json').json()
        self.assertEqual(self.a.delete(f'/api/planner/columns/{self.doing}/').status_code, 204)
        self.assertTrue(Task.objects.filter(id=t['id']).exists())
