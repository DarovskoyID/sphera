from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = 'Run Kafka consumer worker for processing messages and notifications'

    def handle(self, *args, **options):
        from sfera_messages.kafka_worker import run_worker
        self.stdout.write(self.style.SUCCESS('Starting Kafka worker...'))
        run_worker()
