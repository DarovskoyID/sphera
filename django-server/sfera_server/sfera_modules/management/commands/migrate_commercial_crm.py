"""Explicit migration of integration settings, never user content or node encryption keys."""
from types import SimpleNamespace
from django.apps import apps
from django.core.management.base import BaseCommand, CommandError
from sfera_modules.commercial import CRM_IDS, CommercialError, call


class Command(BaseCommand):
    help = 'Inspect/migrate an existing CRM connection to the company API. Does not delete local settings.'

    def add_arguments(self, parser):
        parser.add_argument('--module', choices=sorted(CRM_IDS), required=True)
        parser.add_argument('--apply', action='store_true')

    def handle(self, *args, **options):
        module_id = options['module']
        try:
            model = apps.get_model(f'sfera_{module_id}', 'Connection')
        except LookupError:
            self.stdout.write('No legacy connection app; nothing to migrate.')
            return
        connection = model.objects.first()
        if not connection or not connection.configured:
            self.stdout.write('No configured legacy connection; nothing to migrate.')
            return
        if not options['apply']:
            self.stdout.write('Configured integration found. Use --apply to transfer only its settings and credentials. Local settings and ACLs will be retained.')
            return
        if module_id == 'amocrm':
            fields = ('domain', 'access_token', 'refresh_token', 'client_id', 'client_secret', 'redirect_uri', 'pipeline_id')
        elif module_id == 'bitrix':
            fields = ('webhook_url', 'default_responsible_id')
        else:
            fields = ('base_url', 'username', 'password', 'counterparty_entity', 'product_entity', 'document_entity', 'document_counterparty_field', 'inn_field')
        values = {field: getattr(connection, field) for field in fields}
        if module_id == 'amocrm' and connection.token_expires_at:
            values['token_expires_at'] = connection.token_expires_at.isoformat()
        try:
            call(SimpleNamespace(id='integration-migration', is_superuser=True), module_id=module_id, action_id='configure', values=values)
        except CommercialError as error:
            raise CommandError(f'Migration refused: {error.code}. Local data was retained.') from None
        self.stdout.write('Integration settings migrated. Local settings, user ACLs and event history retained. No credentials printed.')
