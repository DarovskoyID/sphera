/**
 * The user profile — one modal, used everywhere a person's name is clickable.
 *
 * A modal rather than a screen of its own. A profile is almost always opened
 * from the middle of something else: a message, a member list, a call. Taking
 * the reader somewhere and making them find their way back costs more than the
 * profile is worth. On a phone it fills the screen, because at that width a
 * floating card with a strip of chat behind it is neither one thing nor the
 * other.
 *
 * The caller passes whatever it already knows about the user — usually the
 * short form embedded in a message — and the full profile is fetched on open.
 * So the modal paints immediately with a name and an avatar, and fills in.
 */
import React, { useState, useEffect } from 'react';
import {
  X, Phone, Video, UserMinus, UserPlus, Copy, Check, Link as LinkIcon,
  Gift, Pencil,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import ConfirmModal from './ConfirmModal';
import { AccountBadge, accountDisplayName } from './BotBadge';

export type ProfileUser = {
  id: string;
  username: string;
  nickname: string;
  avatar: string;
  bio?: string;
  status: string;
};

interface ProfileLink { label: string; url: string }
interface MutualGuild { id: string; name: string }

/** What /api/auth/users/<id>/profile/ answers with. */
interface FullProfile extends ProfileUser {
  banner?: string;
  status_text?: string;
  links?: ProfileLink[];
  date_joined?: string;
  is_self?: boolean;
  is_friend?: boolean;
  /** The subject hides their profile from strangers; most fields are absent. */
  restricted?: boolean;
  mutual_friends?: ProfileUser[];
  mutual_guilds?: MutualGuild[];
  gifts?: { id: string; name: string; icon: string }[];
}

const STATUS_COLOR: Record<string, string> = {
  online: 'var(--status-online)',
  idle: 'var(--status-idle)',
  dnd: 'var(--status-dnd)',
  offline: 'var(--status-offline)',
};

const STATUS_KEYS: Record<string, string> = {
  online: 'status_online', idle: 'status_idle', dnd: 'status_dnd', offline: 'status_offline',
};

function useIsMobile() {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

const Avatar: React.FC<{ name: string; avatar: string; size?: number }> = ({ name, avatar, size = 40 }) => (
  avatar
    ? <img src={avatar} alt={name} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover' }} />
    : <div style={{
        width: size, height: size, borderRadius: '50%',
        background: 'var(--accent-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#fff', fontWeight: 700, fontSize: size * 0.38, lineHeight: 1, flexShrink: 0,
      }}>
        {name[0]?.toUpperCase() ?? '?'}
      </div>
);

const sectionLabel: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)',
  letterSpacing: 0.5, marginBottom: 6, textTransform: 'uppercase',
};

/** The @name, which is how people are found in search — so it is copyable. */
const UsernameChip: React.FC<{ username: string }> = ({ username }) => {
  const tr = useTranslation();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`@${username}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* no clipboard permission; the text is on screen regardless */ }
  };

  return (
    <button
      onClick={copy}
      title={tr('profile_copy_username')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        fontSize: 13, color: copied ? 'var(--status-online)' : 'var(--text-secondary)',
      }}
    >
      @{username}
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
};

// Full profiles already fetched this session, keyed by user id. The card is
// mounted inside server member / voice rows that re-render (and can re-mount)
// constantly from presence polling and the 80ms speaking-indicator tick. Without
// this, any re-run repainted the short form and re-fetched — the card visibly
// jerked between the compact and full layouts. Seeding from the cache means a
// re-open (or re-mount) shows the full profile immediately, with no flash back
// to the short form.
const profileFetchCache = new Map<string, FullProfile>();

export const ProfileModal: React.FC<{
  user: ProfileUser;
  onClose: () => void;
  /** Optional — if provided, shows Call/Video buttons */
  onCall?: (withVideo: boolean) => void;
}> = ({ user, onClose, onCall }) => {
  const {
    currentServerIP, authToken, friends, sendFriendRequest, removeFriend,
    setCurrentSettingsPage,
  } = useApp();
  const [profile, setProfile] = useState<FullProfile>(
    () => profileFetchCache.get(String(user.id)) ?? user,
  );
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [note, setNote] = useState(() => localStorage.getItem(`note_${user.id}`) ?? '');
  const tr = useTranslation();
  const isMobile = useIsMobile();

  const displayName = accountDisplayName(profile);
  const isFriend = profile.is_friend ?? friends.some(f => String(f.id) === String(user.id));
  const isSelf = profile.is_self ?? false;

  // Paint with what the caller knew, then replace it with the full profile.
  useEffect(() => {
    let cancelled = false;
    // Show the cached full profile if we already have it (no flash back to the
    // short form); otherwise the caller's short form until the fetch lands.
    const cached = profileFetchCache.get(String(user.id));
    setProfile(cached ?? user);
    (async () => {
      try {
        const res = await fetch(
          `${currentServerIP}/api/auth/users/${user.id}/profile/`,
          { headers: { Authorization: `Bearer ${authToken}` } },
        );
        if (!res.ok || cancelled) return;
        const full: FullProfile = await res.json();
        const merged = { ...(cached ?? user), ...full };
        profileFetchCache.set(String(user.id), merged);
        if (!cancelled) setProfile(merged);
      } catch { /* the short form stays on screen */ }
    })();
    return () => { cancelled = true; };
    // Key on the user *id*, not the whole object. Callers (e.g. server member
    // rows) rebuild the `user` prop as a fresh literal on every render, and those
    // rows re-render constantly from presence polling / WS updates. Depending on
    // the object identity re-ran this effect each tick — resetting to the short
    // form and re-fetching — which made the open card visibly twitch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id, currentServerIP, authToken]);

  const joined = profile.date_joined
    ? new Date(profile.date_joined).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
    : '';

  const shell: React.CSSProperties = isMobile
    ? {
      // Full screen on a phone. `100dvh` rather than `100vh` so the browser's
      // own chrome does not push the close button off the bottom.
      background: 'var(--bg-secondary)',
      width: '100vw', height: '100dvh',
      overflowY: 'auto', display: 'flex', flexDirection: 'column',
    }
    : {
      background: 'var(--bg-secondary)',
      borderRadius: 16, overflow: 'hidden',
      width: 400, maxWidth: '94vw',
      maxHeight: '88vh', overflowY: 'auto',
      border: '1px solid var(--border-color)',
      boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
    };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: isMobile ? 'var(--bg-secondary)' : 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div style={shell} onClick={e => e.stopPropagation()}>
        {/* Banner */}
        <div style={{
          height: isMobile ? 128 : 96,
          background: profile.banner
            ? `center / cover no-repeat url(${JSON.stringify(profile.banner)})`
            : 'var(--bg-tertiary)',
          borderBottom: '1px solid var(--border-color)',
          position: 'relative', flexShrink: 0,
        }}>
          <button onClick={onClose} aria-label={tr('cancel')} style={{
            position: 'absolute', top: 10, right: 10,
            background: 'rgba(0,0,0,0.45)', border: 'none', borderRadius: 6,
            color: '#fff', cursor: 'pointer', padding: 6, display: 'flex',
          }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '0 20px 24px', marginTop: -40 }}>
          {/* Identity */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 12 }}>
            <div style={{ position: 'relative', flexShrink: 0 }}>
              {/* 88, not 80: `box-sizing: border-box` is global, so a 80-wide
                  ring leaves only 72 inside and the avatar was clipped off
                  centre — which is what tipped the initial out of its circle. */}
              <div style={{ width: 88, height: 88, borderRadius: '50%', border: '4px solid var(--bg-secondary)', overflow: 'hidden' }}>
                <Avatar name={displayName} avatar={profile.avatar} size={80} />
              </div>
              <span style={{
                position: 'absolute', bottom: 6, right: 6,
                width: 16, height: 16, borderRadius: '50%',
                background: STATUS_COLOR[profile.status] ?? STATUS_COLOR.offline,
                border: '3px solid var(--bg-secondary)',
              }} />
            </div>
            <div style={{ paddingBottom: 4, minWidth: 0, flex: 1 }}>
              <div style={{
                fontSize: 19, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2,
                display: 'flex', alignItems: 'center',
              }}>
                {/* A long name shortens rather than shoving the badge, the
                    @name and the status out past the card's edge. */}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {displayName}
                </span>
                <AccountBadge account={profile} size="md" />
              </div>
              <UsernameChip username={profile.username} />
              <div style={{ fontSize: 12, color: STATUS_COLOR[profile.status] ?? STATUS_COLOR.offline, marginTop: 2 }}>
                {tr((STATUS_KEYS[profile.status] ?? 'status_offline') as never)}
              </div>
            </div>
          </div>

          {/* What they are up to right now */}
          {profile.status_text && (
            <div style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 12 }}>
              {profile.status_text}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
            {isSelf ? (
              <button
                onClick={() => { setCurrentSettingsPage('profile'); onClose(); }}
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '10px 0', background: 'var(--accent-primary)', border: 'none', borderRadius: 8, color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
              >
                <Pencil size={15} /> {tr('profile_edit')}
              </button>
            ) : (
              <>
                {onCall && (
                  <>
                    <button onClick={() => onCall(false)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px 0', background: 'var(--accent-primary)', border: 'none', borderRadius: 8, color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                      <Phone size={15} /> {tr('profile_call')}
                    </button>
                    <button onClick={() => onCall(true)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px 0', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                      <Video size={15} /> {tr('profile_video')}
                    </button>
                  </>
                )}
                {isFriend ? (
                  <button onClick={() => setShowRemoveConfirm(true)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px 12px', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, color: '#ef4444', fontWeight: 600, fontSize: 13, cursor: 'pointer' }} title={tr('profile_remove_friend')}>
                    <UserMinus size={15} />
                  </button>
                ) : (
                  <button onClick={() => sendFriendRequest(user.id)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px 12px', background: 'var(--accent-primary)', border: 'none', borderRadius: 8, color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }} title={tr('profile_add_friend')}>
                    <UserPlus size={15} />
                  </button>
                )}
              </>
            )}
          </div>

          {/* A profile the subject keeps to themselves. Say so, rather than
              showing a page of blanks that reads as a broken screen. */}
          {profile.restricted && (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 16, padding: '10px 12px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
              {tr('profile_restricted')}
            </div>
          )}

          {/* About */}
          {profile.bio && (
            <div style={{ marginBottom: 16 }}>
              <div style={sectionLabel}>{tr('profile_about')}</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, padding: '9px 12px', background: 'var(--bg-tertiary)', borderRadius: 8, whiteSpace: 'pre-wrap' }}>
                {profile.bio}
              </div>
            </div>
          )}

          {/* Links */}
          {!!profile.links?.length && (
            <div style={{ marginBottom: 16 }}>
              <div style={sectionLabel}>{tr('profile_links')}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {profile.links.map((link, i) => (
                  <a
                    key={i}
                    href={link.url}
                    target="_blank"
                    // Someone else's link, opened in a new tab: deny it any
                    // handle on the window that opened it, and any referrer.
                    rel="noopener noreferrer nofollow"
                    style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--accent-primary)', textDecoration: 'none', wordBreak: 'break-all' }}
                  >
                    <LinkIcon size={13} style={{ flexShrink: 0 }} />
                    {link.label || link.url}
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Gifts. The feature does not exist yet — the shelf is here so the
              profile has somewhere to put them, and says so meanwhile. */}
          {!profile.restricted && (
            <div style={{ marginBottom: 16 }}>
              <div style={sectionLabel}>{tr('profile_gifts')}</div>
              {profile.gifts?.length ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {profile.gifts.map(gift => (
                    <div key={gift.id} title={gift.name} style={{ width: 44, height: 44, borderRadius: 10, background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>
                      {gift.icon}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-tertiary)', padding: '10px 12px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
                  <Gift size={15} /> {tr('profile_no_gifts')}
                </div>
              )}
            </div>
          )}

          {/* Member since */}
          {joined && (
            <div style={{ marginBottom: 16 }}>
              <div style={sectionLabel}>{tr('profile_member_since')}</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{joined}</div>
            </div>
          )}

          {/* A private note, kept on this device and shown to nobody. */}
          {!isSelf && (
            <div style={{ marginBottom: 16 }}>
              <div style={sectionLabel}>{tr('profile_note')}</div>
              <textarea
                value={note}
                onChange={e => { setNote(e.target.value); localStorage.setItem(`note_${user.id}`, e.target.value); }}
                placeholder={tr('profile_note_placeholder')}
                style={{ width: '100%', padding: '8px 10px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', resize: 'vertical', minHeight: 64, outline: 'none' }}
              />
            </div>
          )}

          {/* Mutual servers */}
          {!!profile.mutual_guilds?.length && (
            <div style={{ marginBottom: 16 }}>
              <div style={sectionLabel}>
                {profile.mutual_guilds.length} {tr('profile_mutual_servers')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {profile.mutual_guilds.map(guild => (
                  <span key={guild.id} style={{ fontSize: 12, padding: '4px 9px', borderRadius: 999, background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                    {guild.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Mutual friends */}
          {!!profile.mutual_friends?.length && (
            <div>
              <div style={sectionLabel}>
                {profile.mutual_friends.length}{' '}
                {profile.mutual_friends.length !== 1 ? tr('profile_mutual_friends') : tr('profile_mutual_friend')}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {profile.mutual_friends.map(mf => (
                  <div key={mf.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Avatar name={mf.nickname || mf.username} avatar={mf.avatar} size={28} />
                    <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{mf.nickname || mf.username}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {showRemoveConfirm && (
        <ConfirmModal
          title={tr('remove_friend_title')}
          message={tr('remove_friend_confirm')}
          confirmLabel={tr('remove_friend_button')}
          cancelLabel={tr('cancel')}
          onConfirm={() => { removeFriend(user.id); onClose(); }}
          onCancel={() => setShowRemoveConfirm(false)}
        />
      )}
    </div>
  );
};
