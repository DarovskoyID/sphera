import secrets
import uuid

from django.conf import settings
from django.db import models


class Family(models.Model):
    """A household: some adults, and the children whose accounts they manage.

    Deliberately flat. Any parent may act for any child in the family, because
    the alternative — pairing each child with one particular adult — breaks the
    moment the other parent is the one holding the phone.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=60)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='families_created',
    )
    # Redeemed by another adult to join as a second parent.
    invite_code = models.CharField(max_length=16, unique=True, blank=True)
    # The household's server, when the servers module is present. A plain id,
    # not a foreign key: family must work without servers.
    server_id = models.UUIDField(null=True, blank=True, db_column='guild_id')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'sfera_auth_family'

    def save(self, *args, **kwargs):
        if not self.invite_code:
            self.invite_code = secrets.token_urlsafe(9)[:12]
        super().save(*args, **kwargs)

    def __str__(self):
        return self.name


class FamilyMembership(models.Model):
    ROLE_CHOICES = [('parent', 'Parent'), ('child', 'Child')]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    family = models.ForeignKey(Family, on_delete=models.CASCADE, related_name='memberships')
    # One family per person: someone in two households has no single answer to
    # "who approves this", and the feature rests on there being one.
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='family_membership')
    role = models.CharField(max_length=6, choices=ROLE_CHOICES, default='parent')
    birth_date = models.DateField(null=True, blank=True)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'sfera_auth_familymembership'

    def __str__(self):
        return f'{self.user} in {self.family} ({self.role})'


class FamilyLocation(models.Model):
    """A member's live location shared with their household.

    Opt-in per person and per session; it stops on its own at live_until. There
    is deliberately no way for one member to switch on another's sharing.
    """
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='family_location')
    family = models.ForeignKey(Family, on_delete=models.CASCADE, related_name='locations')
    lat = models.FloatField()
    lng = models.FloatField()
    label = models.CharField(max_length=120, blank=True, default='')
    live_until = models.DateTimeField(db_index=True)
    updated_at = models.DateTimeField(auto_now=True)
