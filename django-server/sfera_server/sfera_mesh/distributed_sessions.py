"""Device login at any entry using consensus-owned application identities.

Unlike legacy explicit binding, no prior password login on the new entry is
needed. The owner/profile and active device must already be confirmed by quorum.
The existing one-time challenge and device signatures still mint every session.
"""
from .application_sessions import ApplicationSessions
from .application_profiles import application_user_id, validate_profiles
from .directory import digest64


class DistributedApplicationSessions(ApplicationSessions):
    def __init__(self, path, directory, entry, *, entry_key=None):
        super().__init__(path,directory,entry,entry_key=entry_key,identity_policy='consensus-profile-v1')

    def _profile_user(self, owner):
        if not digest64(owner):
            raise ValueError('invalid_application_identity')
        self.directory.anchor()
        state = self.directory.current['state']
        validate_profiles(state,self.directory.network,self.directory.pin)
        if not state.get('application_profiles',{}).get(owner):
            raise ValueError('application_profile_not_confirmed')
        return application_user_id(self.directory.network,owner)

    def challenge(self, user, jti, owner, device, *, now=None, purpose='bind'):
        with self.directory.lock:
            if str(user) != self._profile_user(owner):
                raise ValueError('application_distributed_identity_mismatch')
            return super().challenge(user,jti,owner,device,now=now,purpose=purpose)

    def login_challenge(self, owner, device, *, now=None):
        with self.directory.lock, self.lock:
            user = self._profile_user(owner)
            self._device(owner,device)
            # This association carries no grant: it is derived solely from the
            # network identity. complete() still verifies an active device's
            # fresh proof before creating any session.
            with self.db:
                rows = self.db.execute('SELECT owner,user FROM app_identities WHERE owner=? OR user=?',(owner,user)).fetchall()
                if rows and rows != [(owner,user)]:
                    raise ValueError('application_distributed_identity_conflict')
                self.db.execute('INSERT OR IGNORE INTO app_identities VALUES(?,?)',(owner,user))
            return super().login_challenge(owner,device,now=now)

    def require(self, user, claim, *, now=None):
        with self.directory.lock:
            owner = claim.get('owner') if isinstance(claim,dict) else None
            if str(user) != self._profile_user(owner):
                raise ValueError('application_distributed_identity_mismatch')
            return super().require(user,claim,now=now)
