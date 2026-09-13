"""Create the instance's single superuser.

The superuser is the only account that can install and remove modules. There is
exactly one (a DB constraint enforces it), so this command never creates a
second one: if a superuser exists it does nothing.

Credentials, first match wins:
  1. --username / --email / --password
  2. SFERA_SUPERUSER_USERNAME, SFERA_SUPERUSER_EMAIL, SFERA_SUPERUSER_PASSWORD (.env, deploy.env,
     /etc/sfera/secrets.env)
  3. interactive prompt, when stdin is a terminal (first install by hand)
"""
import getpass
import os
import sys

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction


class Command(BaseCommand):
    help = 'Create the single superuser (who manages modules) from arguments, env or a prompt.'

    def add_arguments(self, parser):
        parser.add_argument('--username')
        parser.add_argument('--email')
        parser.add_argument('--password')
        parser.add_argument('--no-input', action='store_true', help='Never prompt; skip if credentials are missing.')

    def handle(self, *args, **opts):
        User = get_user_model()
        existing = User.objects.filter(is_superuser=True).first()
        if existing:
            self.stdout.write(f'Superuser already exists: {existing.username}')
            return

        username = opts['username'] or os.environ.get('SFERA_SUPERUSER_USERNAME', '')
        email = opts['email'] or os.environ.get('SFERA_SUPERUSER_EMAIL', '')
        password = opts['password'] or os.environ.get('SFERA_SUPERUSER_PASSWORD', '')

        interactive = not opts['no_input'] and sys.stdin.isatty()
        if not (username and password) and interactive:
            self.stdout.write('Создание суперпользователя Сферы (только он устанавливает модули).')
            username = username or input('Логин: ').strip()
            email = email or input('Email (необязательно): ').strip()
            while not password:
                first = getpass.getpass('Пароль: ')
                if first != getpass.getpass('Пароль ещё раз: '):
                    self.stderr.write('Пароли не совпадают.')
                    continue
                password = first

        if not (username and password):
            self.stderr.write(self.style.WARNING(
                'Superuser not created: set SFERA_SUPERUSER_USERNAME and SFERA_SUPERUSER_PASSWORD '
                '(or run `manage.py ensure_superuser` in a terminal). Until then nobody can install modules.'
            ))
            return

        try:
            validate_password(password)
        except ValidationError as e:
            raise CommandError('Weak superuser password: ' + ' '.join(e.messages))

        with transaction.atomic():
            user = User.objects.filter(username=username).first()
            if user:
                # Promote an account that already registered with this name.
                user.is_superuser = True
                user.is_staff = True
                user.set_password(password)
                if email:
                    user.email = email
                user.save()
                self.stdout.write(self.style.SUCCESS(f'Existing user {username} promoted to superuser'))
            else:
                User.objects.create_superuser(username=username, email=email, password=password)
                self.stdout.write(self.style.SUCCESS(f'Superuser {username} created'))
