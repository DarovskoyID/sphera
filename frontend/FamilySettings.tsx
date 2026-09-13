import React, { useCallback, useEffect, useState } from 'react';
import { ListSkeleton, settingsUi, useCore, useT } from '@sfera/sdk';

const { card, sectionH3, fieldLabel, fieldInput, btnPrimary, btnSecondary, btnDanger, statusMsg } = settingsUi;

/** Core app state; guild helpers are optional (present while servers exist). */
function useApp() {
  return useCore() as ReturnType<typeof useCore> & {
    guilds?: { id: string }[]; loadGuilds?: () => Promise<void>;
  };
}
const useTranslation = useT;

// ==================== Family centre ====================
//
// A household: some adults, and the children whose accounts they manage. What
// a child's account gets is the content filter locked on and friendships that
// wait for a parent — see the server for both. This screen is the parent's
// view of that, and the child's explanation of it.

interface FamilyMemberRow {
  id: string;
  role: 'parent' | 'child';
  birth_date: string | null;
  user: { id: string; username: string; nickname: string; avatar: string };
}

interface FamilyApproval {
  id: string;
  child_asked: boolean;
  child: { username: string; nickname: string };
  other: { username: string; nickname: string };
}

interface FamilyLocation {
  user: { id: string; username: string; nickname: string; avatar: string };
  lat: number;
  lng: number;
  label: string;
  updated_at: string;
  live_until: string;
  is_self: boolean;
}

interface FamilyData {
  id: string;
  name: string;
  /** The household's own server. Empty only for a family made before it had one. */
  guild_id: string;
  invite_code: string;
  my_role: 'parent' | 'child';
  members: FamilyMemberRow[];
  pending_approvals: FamilyApproval[];
}

export const FamilySettings: React.FC = () => {
  const tr = useTranslation();
  const isRu = tr('settings_formatting') === 'Подсказки';
  const {
    currentServerIP, authToken, guilds, selectGuild, setCurrentView,
    setCurrentSettingsPage, currentUser, loadGuilds,
  } = useApp();

  const [family, setFamily] = useState<FamilyData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; type: 'ok' | 'err' } | null>(null);

  const [locations, setLocations] = useState<FamilyLocation[]>([]);
  const [sharing, setSharing] = useState(false);
  const [locationError, setLocationError] = useState('');
  const [familyName, setFamilyName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [childName, setChildName] = useState('');
  const [childLogin, setChildLogin] = useState('');
  const [childPassword, setChildPassword] = useState('');
  const [childBirth, setChildBirth] = useState('');
  const [copied, setCopied] = useState(false);

  /** Every endpoint here answers with the whole family, so one handler does. */
  const call = useCallback(async (path: string, body?: unknown): Promise<boolean> => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`${currentServerIP}/api/family/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ text: data.error || tr('sp_save_fail'), type: 'err' });
        return false;
      }
      setFamily(data.family ?? null);
      // The household's server may have been created by this very call — on a
      // family made before it existed, or by adding a member. Re-read the
      // guild list so the button below has something to open.
      const guildId = data.family?.guild_id;
      if (guildId && guilds && !guilds.some(g => String(g.id) === guildId)) void loadGuilds?.();
      return true;
    } catch {
      setMsg({ text: tr('sp_save_fail'), type: 'err' });
      return false;
    } finally {
      setBusy(false);
      setLoaded(true);
    }
  }, [currentServerIP, authToken, tr, guilds, loadGuilds]);

  useEffect(() => { if (authToken) void call(''); }, [authToken, call]);

  const loadLocations = useCallback(async () => {
    try {
      const res = await fetch(`${currentServerIP}/api/family/locations/`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) setLocations((await res.json()).locations ?? []);
    } catch { /* the list simply stays as it was */ }
  }, [currentServerIP, authToken]);

  // A share updates every twenty seconds; re-reading on the same order keeps
  // the list roughly current without polling for its own sake.
  useEffect(() => {
    if (!authToken) return;
    void loadLocations();
    const timer = setInterval(() => { void loadLocations(); }, 20000);
    return () => clearInterval(timer);
  }, [authToken, loadLocations]);

  const addChild = async () => {
    const ok = await call('children/', {
      username: childLogin.trim(),
      password: childPassword,
      nickname: childName.trim(),
      birth_date: childBirth || null,
    });
    if (ok) {
      setChildName(''); setChildLogin(''); setChildPassword(''); setChildBirth('');
      setMsg({ text: isRu ? 'Аккаунт создан.' : 'Account created.', type: 'ok' });
    }
  };

  if (!loaded) return <section><h1>{tr('settings_family')}</h1><ListSkeleton rows={3} /></section>;

  // ── Not in a family yet ────────────────────────────────────────────────────
  if (!family) {
    return (
      <section>
        <h1>{tr('settings_family')}</h1>
        <p>{isRu
          ? 'Семья — это взрослые и детские аккаунты, которыми они управляют. У ребёнка фильтр сообщений всегда включён, а новые друзья появляются только с вашего разрешения.'
          : 'A family is some adults and the child accounts they manage. A child always has the message filter on, and only gains friends you have agreed to.'}</p>

        <div style={card}>
          <h3 style={sectionH3}>{isRu ? 'Создать семью' : 'Start a family'}</h3>
          <div style={{ marginBottom: 12 }}>
            <div style={fieldLabel}>{isRu ? 'Название' : 'Name'}</div>
            <input style={fieldInput} value={familyName} maxLength={60}
              onChange={e => setFamilyName(e.target.value)}
              placeholder={isRu ? 'Например: Ивановы' : 'For example: the Ivanovs'} />
          </div>
          <button style={{ ...btnPrimary, opacity: busy || !familyName.trim() ? 0.6 : 1 }}
            disabled={busy || !familyName.trim()}
            onClick={() => void call('', { name: familyName.trim() })}>
            {isRu ? 'Создать' : 'Create'}
          </button>
        </div>

        <div style={card}>
          <h3 style={sectionH3}>{isRu ? 'Присоединиться по коду' : 'Join with a code'}</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
            {isRu
              ? 'Второй взрослый вводит код семьи и получает те же права.'
              : 'A second adult enters the family code and gets the same rights.'}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={fieldInput} value={joinCode}
              onChange={e => setJoinCode(e.target.value)} placeholder={isRu ? 'Код' : 'Code'} />
            <button style={{ ...btnSecondary, opacity: busy || !joinCode.trim() ? 0.6 : 1 }}
              disabled={busy || !joinCode.trim()}
              onClick={() => void call('join/', { invite_code: joinCode.trim() })}>
              {isRu ? 'Войти' : 'Join'}
            </button>
          </div>
        </div>

        {msg && <div style={statusMsg(msg.type)}>{msg.text}</div>}
      </section>
    );
  }

  const isParent = family.my_role === 'parent';
  const children = family.members.filter(m => m.role === 'child');
  const familyGuild = guilds?.find(g => String(g.id) === family.guild_id);
  const iShare = locations.some(spot => spot.is_self);

  /** Share where I am with the household, for the next eight hours (opt-in, expires on its own). */
  const shareLocation = async () => {
    setSharing(true);
    setLocationError('');
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        if (!navigator.geolocation) { reject(new Error('unsupported')); return; }
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
      });
      const res = await fetch(`${currentServerIP}/api/family/location/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: position.coords.latitude, lng: position.coords.longitude, minutes: 8 * 60,
          label: currentUser?.nickname || currentUser?.username || '',
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      await loadLocations();
    } catch {
      setLocationError(isRu
        ? 'Не удалось определить местоположение. Проверьте разрешение для сайта.'
        : 'Could not get a location. Check the permission for this site.');
    } finally {
      setSharing(false);
    }
  };

  const stopSharing = async () => {
    await fetch(`${currentServerIP}/api/family/location/`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } }).catch(() => {});
    await loadLocations();
  };

  return (
    <section>
      <h1>{family.name}</h1>
      <p>{isParent
        ? (isRu
          ? 'Взрослые управляют детскими аккаунтами: фильтр сообщений у ребёнка всегда включён, а заявки в друзья проходят через вас.'
          : 'The adults here manage the child accounts: a child always has the message filter on, and friend requests come to you.')
        : (isRu
          ? 'Вашим аккаунтом управляют родители. Фильтр сообщений включён всегда, а новые друзья добавляются с их разрешения.'
          : 'Your account is managed by a parent. The message filter is always on, and new friends need their agreement.')}</p>

      {/* Requests waiting on a parent */}
      {isParent && (
        <div style={card}>
          <h3 style={sectionH3}>{isRu ? 'Заявки в друзья' : 'Friend requests'}</h3>
          {family.pending_approvals.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
              {isRu ? 'Ничего не ждёт вашего решения.' : 'Nothing is waiting for you.'}
            </p>
          ) : family.pending_approvals.map(approval => (
            <div key={approval.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              padding: '10px 0', borderBottom: '1px solid var(--border-color)',
            }}>
              <span style={{ flex: 1, minWidth: 200, fontSize: 13, color: 'var(--text-primary)' }}>
                {approval.child_asked
                  ? (isRu
                    ? `${approval.child.nickname || approval.child.username} хочет добавить @${approval.other.username}`
                    : `${approval.child.nickname || approval.child.username} wants to add @${approval.other.username}`)
                  : (isRu
                    ? `@${approval.other.username} хочет добавить ${approval.child.nickname || approval.child.username}`
                    : `@${approval.other.username} wants to add ${approval.child.nickname || approval.child.username}`)}
              </span>
              <button style={btnPrimary} disabled={busy}
                onClick={() => void call(`approvals/${approval.id}/`, { approve: true })}>
                {isRu ? 'Разрешить' : 'Allow'}
              </button>
              <button style={btnSecondary} disabled={busy}
                onClick={() => void call(`approvals/${approval.id}/`, { approve: false })}>
                {isRu ? 'Отклонить' : 'Refuse'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* The household's own chat */}
      {familyGuild && (
        <div style={card}>
          <h3 style={sectionH3}>{isRu ? 'Семейный чат' : 'Family chat'}</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
            {isRu
              ? 'Закрытый сервер только для вас: общий чат, канал заметок и голосовая комната. В поиске серверов его не видно.'
              : 'A closed server just for you: the chat, a notes channel and a voice room. It is not listed in the server search.'}
          </p>
          <button
            style={btnPrimary}
            onClick={() => {
              setCurrentSettingsPage('');
              setCurrentView('home');
              selectGuild(familyGuild);
            }}
          >
            {isRu ? 'Открыть' : 'Open'}
          </button>
        </div>
      )}

      {/* Where everyone is */}
      {(
        <div style={card}>
          <h3 style={sectionH3}>{isRu ? 'Где все' : 'Where everyone is'}</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
            {isRu
              ? 'Каждый включает это сам и сам выключает. Показать чужое местоположение за человека нельзя — в том числе за ребёнка.'
              : 'Everyone turns this on for themselves, and off again. Nobody can share another person’s location for them — a child’s included.'}
          </p>

          {locations.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-tertiary)', margin: '0 0 12px' }}>
              {isRu ? 'Сейчас никто не делится местоположением.' : 'Nobody is sharing right now.'}
            </p>
          ) : (
            <div style={{ marginBottom: 12 }}>
              {locations.map(spot => (
                <div key={spot.user.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                  padding: '9px 0', borderBottom: '1px solid var(--border-color)',
                }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontSize: 14, color: 'var(--text-primary)' }}>
                      {spot.user.nickname || spot.user.username}
                      {spot.is_self && <span style={{ color: 'var(--text-tertiary)' }}> · {isRu ? 'вы' : 'you'}</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {spot.label ? `${spot.label} · ` : ''}
                      {isRu ? 'обновлено' : 'updated'} {new Date(spot.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                  <a
                    href={`https://www.openstreetmap.org/?mlat=${spot.lat}&mlon=${spot.lng}#map=16/${spot.lat}/${spot.lng}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ ...btnSecondary, textDecoration: 'none', display: 'inline-block' }}
                  >
                    {isRu ? 'На карте' : 'On the map'}
                  </a>
                </div>
              ))}
            </div>
          )}

          <button
            style={{ ...btnPrimary, opacity: sharing ? 0.6 : 1 }}
            disabled={sharing}
            onClick={() => void shareLocation()}
          >
            {iShare
              ? (isRu ? 'Продлить на 8 часов' : 'Keep sharing for 8 more hours')
              : (isRu ? 'Поделиться на 8 часов' : 'Share for 8 hours')}
          </button>
          {iShare && (
            <button style={{ ...btnSecondary, marginLeft: 8 }} onClick={() => void stopSharing()}>
              {isRu ? 'Перестать делиться' : 'Stop sharing'}
            </button>
          )}
          {locationError && <div style={statusMsg('err')}>{locationError}</div>}
        </div>
      )}

      {/* Who is in the family */}
      <div style={card}>
        <h3 style={sectionH3}>{isRu ? 'Участники' : 'Members'}</h3>
        {family.members.map(member => (
          <div key={member.id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '9px 0', borderBottom: '1px solid var(--border-color)',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, color: 'var(--text-primary)' }}>
                {member.user.nickname || member.user.username}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                @{member.user.username} · {member.role === 'parent'
                  ? (isRu ? 'взрослый' : 'adult')
                  : (isRu ? 'ребёнок' : 'child')}
              </div>
            </div>
            {isParent && (
              <button style={btnDanger} disabled={busy}
                onClick={() => void call(`members/${member.user.id}/remove/`, {})}>
                {isRu ? 'Убрать' : 'Remove'}
              </button>
            )}
          </div>
        ))}
      </div>

      {isParent && (
        <>
          {/* Add a child */}
          <div style={card}>
            <h3 style={sectionH3}>{isRu ? 'Добавить ребёнка' : 'Add a child'}</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 14px' }}>
              {isRu
                ? 'Вы создаёте аккаунт и задаёте пароль. Почты у него нет, так что пароль восстанавливаете тоже вы.'
                : 'You create the account and choose the password. It has no email address, so resetting the password is yours to do as well.'}
            </p>
            <div style={{ marginBottom: 12 }}>
              <div style={fieldLabel}>{tr('sp_display_name')}</div>
              <input style={fieldInput} value={childName} maxLength={50}
                onChange={e => setChildName(e.target.value)} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={fieldLabel}>{tr('sp_username')}</div>
              <input style={fieldInput} value={childLogin} autoComplete="off"
                onChange={e => setChildLogin(e.target.value)} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={fieldLabel}>{tr('sp_new_password')}</div>
              <input type="password" style={fieldInput} value={childPassword} autoComplete="new-password"
                onChange={e => setChildPassword(e.target.value)} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={fieldLabel}>{isRu ? 'Дата рождения' : 'Date of birth'}</div>
              <input type="date" style={fieldInput} value={childBirth}
                onChange={e => setChildBirth(e.target.value)} />
            </div>
            <button style={{ ...btnPrimary, opacity: busy || !childLogin.trim() || !childPassword ? 0.6 : 1 }}
              disabled={busy || !childLogin.trim() || !childPassword}
              onClick={() => void addChild()}>
              {isRu ? 'Создать аккаунт' : 'Create the account'}
            </button>
          </div>

          {/* The code that adds a second adult */}
          <div style={card}>
            <h3 style={sectionH3}>{isRu ? 'Код семьи' : 'Family code'}</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
              {isRu
                ? 'Передайте его второму взрослому — он получит те же права, включая решения по заявкам.'
                : 'Give it to a second adult; they get the same rights, including deciding on requests.'}
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code style={{
                flex: 1, padding: '10px 12px', background: 'var(--bg-primary)',
                border: '1px solid var(--border-color)', borderRadius: 6,
                color: 'var(--text-primary)', fontSize: 14, letterSpacing: 1,
              }}>{family.invite_code}</code>
              <button style={btnSecondary} onClick={() => {
                navigator.clipboard.writeText(family.invite_code)
                  .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); })
                  .catch(() => { /* the code is on screen regardless */ });
              }}>
                {copied ? (isRu ? 'Скопировано' : 'Copied') : (isRu ? 'Скопировать' : 'Copy')}
              </button>
            </div>
          </div>
        </>
      )}

      {/* What a child cannot change, said plainly rather than left to be
          discovered by finding the switches greyed out. */}
      {(isParent && children.length > 0) || !isParent ? (
        <div style={card}>
          <h3 style={sectionH3}>{isRu ? 'Что включено у ребёнка' : 'What is on for a child'}</h3>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            <li>{isRu ? 'Фильтр мата и откровенного содержимого — для всех собеседников' : 'The profanity and explicit-content filter, for everyone they talk to'}</li>
            <li>{isRu ? 'Скрытие сообщений, которые уговаривают отключить фильтр' : 'Messages that talk them into switching the filter off are hidden'}</li>
            <li>{isRu ? 'Новые друзья — только с разрешения взрослого' : 'New friends only with an adult’s agreement'}</li>
          </ul>
        </div>
      ) : null}

      {msg && <div style={statusMsg(msg.type)}>{msg.text}</div>}
    </section>
  );
};

