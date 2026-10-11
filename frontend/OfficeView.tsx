import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import {
  ArrowLeft, Check, Copy, Download, FileSpreadsheet, FileText, History, MessageSquare, MoreHorizontal, Plus,
  Presentation, Search, Share2, Trash2, UserMinus, Wifi, WifiOff,
} from 'lucide-react';
import { navigate, reportError, useCore, useModuleStore, useModuleT } from '@sfera/sdk';
import { api, download, type Conn, type Format } from './api';
import { DeckEditor } from './DeckEditor';
import { DocEditor } from './DocEditor';
import { SheetEditor } from './SheetEditor';
import { DocSession } from './session';
import * as office from './store';
import type { Comment, DocBrief, DocFull, Kind, Revision, Role } from './types';
import {
  Avatar, Button, Confirm, Empty, Field, IconButton, MenuItem, Modal, PopMenu, Segmented, UserPicker,
  displayName, inputStyle, useIsMobile, type UserBrief,
} from './ui';

export const ROUTE = 'office';

export const KIND_ICON: Record<Kind, React.ReactNode> = {
  doc: <FileText size={17} />,
  sheet: <FileSpreadsheet size={17} />,
  deck: <Presentation size={17} />,
};

const KIND_TINT: Record<Kind, string> = { doc: '#4f46e5', sheet: '#059669', deck: '#d97706' };

export function useConn(): Conn {
  const { authToken, currentServerIP } = useCore();
  return useMemo(() => ({ token: authToken, serverIP: currentServerIP }), [authToken, currentServerIP]);
}

function useDate() {
  const { language } = useCore();
  return useCallback((iso: string) => new Date(iso).toLocaleString(language, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }), [language]);
}

export function CreateDialog({ onClose, onCreated, kind: fixedKind }: {
  onClose: () => void;
  onCreated: (doc: DocFull) => void;
  kind?: Kind;
}) {
  const t = useModuleT();
  const conn = useConn();
  const [kind, setKind] = useState<Kind>(fixedKind ?? 'doc');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      onCreated(await api.create(conn, kind, title.trim() || t(`of_untitled_${kind}`)));
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('of_new')} onClose={onClose} width={480} footer={
      <>
        <Button onClick={onClose}>{t('of_cancel')}</Button>
        <Button kind="primary" disabled={busy} onClick={() => void submit()}>{t('of_create')}</Button>
      </>
    }>
      {!fixedKind && (
        <Field label={t('of_kind')}>
          <Segmented value={kind} onChange={setKind} options={[
            { id: 'doc', label: t('of_kind_doc'), icon: KIND_ICON.doc },
            { id: 'sheet', label: t('of_kind_sheet'), icon: KIND_ICON.sheet },
            { id: 'deck', label: t('of_kind_deck'), icon: KIND_ICON.deck },
          ]} />
        </Field>
      )}
      <Field label={t('of_title')}>
        <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder={t(`of_untitled_${kind}`)}
          onKeyDown={e => { if (e.key === 'Enter') void submit(); }} style={inputStyle()} />
      </Field>
    </Modal>
  );
}

function SharePanel({ doc, onChange, onClose }: { doc: DocFull; onChange: (next: DocFull) => void; onClose: () => void }) {
  const t = useModuleT();
  const conn = useConn();
  const { currentServerIP, currentUser } = useCore();
  const search = useCallback((q: string) => api.users(conn, q), [conn]);
  const act = (p: Promise<DocFull | void>) => p.then(next => { if (next) onChange(next); }).catch(reportError);
  return (
    <Modal title={t('of_share')} onClose={onClose} width={520}>
      {doc.role === 'owner' && (
        <Field label={t('of_share_add')} hint={t('of_share_hint')}>
          <UserPicker search={search} serverIP={currentServerIP} placeholder={t('of_share_find')}
            exclude={doc.members.map(m => m.id)}
            onPick={u => void act(api.addMember(conn, doc.id, u.id, 'editor'))} />
        </Field>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>
        {doc.members.map(m => (
          <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border-color)' }}>
            <Avatar user={m} size={30} serverIP={currentServerIP} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(m)}</div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>@{m.username}</div>
            </div>
            {m.role === 'owner' ? (
              <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{t('of_role_owner')}</span>
            ) : doc.role === 'owner' ? (
              <>
                <select value={m.role} onChange={e => void act(api.setRole(conn, doc.id, m.id, e.target.value as Role))}
                  style={{ ...inputStyle(), width: 'auto', padding: '4px 6px', fontSize: 12.5 }}>
                  <option value="editor">{t('of_role_editor')}</option>
                  <option value="viewer">{t('of_role_viewer')}</option>
                </select>
                <IconButton title={t('of_share_remove')} onClick={() => void act(api.removeMember(conn, doc.id, m.id).then(() =>
                  onChange({ ...doc, members: doc.members.filter(x => x.id !== m.id) })))}>
                  <UserMinus size={15} />
                </IconButton>
              </>
            ) : (
              <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{m.role === 'editor' ? t('of_role_editor') : t('of_role_viewer')}</span>
            )}
          </div>
        ))}
      </div>
      {doc.role !== 'owner' && (
        <Button style={{ marginTop: 14, color: '#ef4444' }} onClick={() => {
          if (currentUser) void api.removeMember(conn, doc.id, currentUser.id).then(onClose).catch(reportError);
        }}>{t('of_leave')}</Button>
      )}
    </Modal>
  );
}

function HistoryPanel({ docId, canRestore, onClose, onRestored }: {
  docId: string;
  canRestore: boolean;
  onClose: () => void;
  onRestored: () => void;
}) {
  const t = useModuleT();
  const conn = useConn();
  const date = useDate();
  const [rows, setRows] = useState<Revision[] | null>(null);
  useEffect(() => { api.history(conn, docId).then(setRows).catch(() => setRows([])); }, [conn, docId]);
  return (
    <Modal title={t('of_history')} onClose={onClose} width={480}>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('of_history_hint')}</p>
      {rows && rows.length === 0 && <div style={{ fontSize: 13.5, color: 'var(--text-tertiary)' }}>{t('of_history_empty')}</div>}
      {(rows ?? []).map(r => (
        <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, color: 'var(--text-primary)' }}>{date(r.created_at)}</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              {t('of_version')} {r.version}{r.author ? ` · ${displayName(r.author)}` : ''}
            </div>
          </div>
          {canRestore && (
            <Button small onClick={() => void api.restore(conn, docId, r.id).then(() => { onRestored(); onClose(); }).catch(reportError)}>
              {t('of_restore')}
            </Button>
          )}
        </div>
      ))}
    </Modal>
  );
}

function CommentsPanel({ docId, anchor, onClose }: { docId: string; anchor: string; onClose: () => void }) {
  const t = useModuleT();
  const conn = useConn();
  const date = useDate();
  const { currentServerIP, currentUser } = useCore();
  const [rows, setRows] = useState<Comment[]>([]);
  const [text, setText] = useState('');
  const load = useCallback(() => { api.comments(conn, docId).then(setRows).catch(reportError); }, [conn, docId]);
  useEffect(load, [load]);
  const send = async () => {
    if (!text.trim()) return;
    try {
      const created = await api.comment(conn, docId, anchor, text.trim());
      setRows(prev => [...prev, created]);
      setText('');
    } catch (e) { reportError(e); }
  };
  return (
    <Modal title={t('of_comments')} onClose={onClose} width={460}>
      <div style={{ maxHeight: '45vh', overflow: 'auto', marginBottom: 12 }}>
        {rows.length === 0 && <div style={{ fontSize: 13.5, color: 'var(--text-tertiary)' }}>{t('of_comments_empty')}</div>}
        {rows.map(c => (
          <div key={c.id} style={{ display: 'flex', gap: 9, padding: '8px 0', borderBottom: '1px solid var(--border-color)', opacity: c.resolved ? 0.55 : 1 }}>
            <Avatar user={c.author} size={26} serverIP={currentServerIP} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{displayName(c.author)} · {date(c.created_at)}{c.anchor ? ` · ${t('of_comment_pinned')}` : ''}</div>
              <div style={{ fontSize: 13.5, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', textDecoration: c.resolved ? 'line-through' : undefined }}>{c.text}</div>
            </div>
            <IconButton title={c.resolved ? t('of_comment_reopen') : t('of_comment_resolve')}
              onClick={() => void api.resolveComment(conn, docId, c.id, !c.resolved).then(load).catch(reportError)}>
              <Check size={15} />
            </IconButton>
            {c.author.id === currentUser?.id && (
              <IconButton title={t('of_comment_remove')} onClick={() => void api.removeComment(conn, docId, c.id).then(load).catch(reportError)}>
                <Trash2 size={15} />
              </IconButton>
            )}
          </div>
        ))}
      </div>
      <textarea value={text} onChange={e => setText(e.target.value)} placeholder={t('of_comment_ph')} rows={3}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(); }}
        style={{ width: '100%', border: '1px solid var(--border-color)', borderRadius: 10, background: 'var(--bg-secondary)', color: 'var(--text-primary)', padding: 10, fontSize: 13.5, outline: 'none', resize: 'vertical' }} />
      <Button kind="primary" style={{ marginTop: 8 }} disabled={!text.trim()} onClick={() => void send()}>{t('of_comment_send')}</Button>
    </Modal>
  );
}

function EditorScreen({ docId }: { docId: string }) {
  const t = useModuleT();
  const conn = useConn();
  const { currentServerIP, setCurrentServer } = useCore();
  const isMobile = useIsMobile();
  const [doc, setDoc] = useState<DocFull | null>(null);
  const [session, setSession] = useState<DocSession | null>(null);
  const [error, setError] = useState(false);
  const [title, setTitle] = useState('');
  const [panel, setPanel] = useState<'share' | 'history' | null>(null);
  const [comments, setComments] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [remove, setRemove] = useState(false);

  useEffect(() => {
    let dead = false;
    let s: DocSession | null = null;
    setError(false);
    api.doc(conn, docId).then(full => {
      if (dead) return;
      setDoc(full);
      setTitle(full.title);
      s = new DocSession(conn, full.kind, full.id, full);
      s.connect();
      setSession(s);
    }).catch(() => { if (!dead) setError(true); });
    return () => { dead = true; s?.close(); setSession(null); };
  }, [conn, docId]);

  const tick = useSyncExternalStore(session?.subscribe ?? (() => () => { }), session?.snapshot ?? (() => 0));
  void tick;

  useEffect(() => {
    if (!session?.removed) return;
    office.forget(docId);
    setCurrentServer(navigate.moduleRoute(ROUTE, ''));
  }, [session?.removed, session, docId, setCurrentServer]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); session?.flush(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  if (error) {
    return (
      <Empty icon={<FileText size={30} />} title={t('of_missing')}
        action={<Button onClick={() => setCurrentServer(navigate.moduleRoute(ROUTE, ''))}>{t('of_back')}</Button>} />
    );
  }
  if (!doc || !session) return <div style={{ flex: 1, background: 'var(--bg-primary)' }} />;

  const peers = session.livePeers();
  const formats: Format[] = doc.kind === 'doc' ? ['html', 'md'] : doc.kind === 'sheet' ? ['html', 'csv'] : ['html'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--bg-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border-color)' }}>
        <IconButton title={t('of_all')} onClick={() => setCurrentServer(navigate.moduleRoute(ROUTE, ''))}><ArrowLeft size={17} /></IconButton>
        <span style={{ color: KIND_TINT[doc.kind], display: 'flex', flexShrink: 0 }}>{KIND_ICON[doc.kind]}</span>
        <input value={title} readOnly={!session.canEdit}
          onChange={e => setTitle(e.target.value)}
          onBlur={() => { if (title.trim() && title !== session.title) session.rename(title.trim()); }}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          style={{ flex: 1, minWidth: 80, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 15.5, fontWeight: 700 }} />
        <span title={session.connected ? t('of_live') : t('of_offline')} style={{ color: session.connected ? '#10b981' : 'var(--text-tertiary)', display: 'flex' }}>
          {session.connected ? <Wifi size={15} /> : <WifiOff size={15} />}
        </span>
        {session.saving && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('of_saving')}</span>}
        {!isMobile && peers.slice(0, 4).map(p => (
          <span key={p.channel} title={displayName(p.user)}><Avatar user={p.user} size={24} serverIP={currentServerIP} ring /></span>
        ))}
        {!session.canEdit && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('of_read_only')}</span>}
        <IconButton title={t('of_comments')} onClick={() => setComments('')}><MessageSquare size={16} /></IconButton>
        <IconButton title={t('of_share')} onClick={() => setPanel('share')}><Share2 size={16} /></IconButton>
        <IconButton title={t('of_more')} onClick={e => setMenu({ x: e.clientX, y: e.clientY })}><MoreHorizontal size={17} /></IconButton>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: doc.kind === 'doc' ? 'auto' : 'hidden' }}>
        {doc.kind === 'doc' && <DocEditor session={session} onComment={id => setComments(id)} />}
        {doc.kind === 'sheet' && <SheetEditor session={session} />}
        {doc.kind === 'deck' && <DeckEditor session={session} />}
      </div>

      {menu && (
        <PopMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {formats.map(fmt => (
            <MenuItem key={fmt} icon={<Download size={15} />} label={t(`of_export_${fmt}`)}
              onClick={() => { void download(conn, doc.id, fmt, session.title).catch(reportError); setMenu(null); }} />
          ))}
          <MenuItem icon={<History size={15} />} label={t('of_history')} onClick={() => { setPanel('history'); setMenu(null); }} />
          <MenuItem icon={<Copy size={15} />} label={t('of_duplicate')} onClick={() => {
            setMenu(null);
            void api.create(conn, doc.kind, `${session.title} (${t('of_copy_suffix')})`, session.data)
              .then(copy => { void office.refresh(); setCurrentServer(navigate.moduleRoute(ROUTE, copy.id)); })
              .catch(reportError);
          }} />
          {doc.role === 'owner' && (
            <MenuItem icon={<Trash2 size={15} />} label={t('of_delete')} danger onClick={() => { setRemove(true); setMenu(null); }} />
          )}
        </PopMenu>
      )}
      {panel === 'share' && <SharePanel doc={doc} onChange={setDoc} onClose={() => setPanel(null)} />}
      {panel === 'history' && (
        <HistoryPanel docId={doc.id} canRestore={doc.role === 'owner'} onClose={() => setPanel(null)}
          onRestored={() => void api.doc(conn, doc.id).then(setDoc).catch(reportError)} />
      )}
      {comments !== null && <CommentsPanel docId={doc.id} anchor={comments} onClose={() => setComments(null)} />}
      {remove && (
        <Confirm title={t('of_delete')} message={t('of_delete_hint').replace('{title}', session.title)}
          confirmLabel={t('of_delete')} cancelLabel={t('of_cancel')} onCancel={() => setRemove(false)}
          onConfirm={async () => {
            setRemove(false);
            try {
              await api.remove(conn, doc.id);
              office.forget(doc.id);
              setCurrentServer(navigate.moduleRoute(ROUTE, ''));
            } catch (e) { reportError(e); }
          }} />
      )}
    </div>
  );
}

function DocCard({ doc, onOpen }: { doc: DocBrief; onOpen: () => void }) {
  const t = useModuleT();
  const date = useDate();
  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}
      style={{ padding: 14, borderRadius: 14, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', cursor: 'pointer', display: 'flex', gap: 11, alignItems: 'flex-start' }}>
      <span style={{ width: 36, height: 36, borderRadius: 11, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `color-mix(in srgb, ${KIND_TINT[doc.kind]} 14%, transparent)`, color: KIND_TINT[doc.kind] }}>
        {KIND_ICON[doc.kind]}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.title}</div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          {t(`of_kind_${doc.kind}`)} · {t('of_updated')} {date(doc.updated_at)}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          {doc.role === 'owner' ? t('of_role_owner') : doc.role === 'editor' ? t('of_role_editor') : t('of_role_viewer')}
          {doc.owner && doc.role !== 'owner' ? ` · ${displayName(doc.owner)}` : ''}
        </div>
      </div>
    </div>
  );
}

export function OfficeView({ style }: { style?: CSSProperties }) {
  const t = useModuleT();
  const { currentServer, setCurrentServer } = useCore();
  const docs = useModuleStore(office.store, s => s.docs);
  const loaded = useModuleStore(office.store, s => s.loaded);
  const rest = navigate.parseModuleRoute(currentServer, ROUTE) ?? '';
  const [kind, setKind] = useState<Kind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => { if (!rest) void office.refresh(); }, [rest]);

  if (rest) return <EditorScreen key={rest} docId={rest} />;

  const shown = docs.filter(d => (kind === 'all' || d.kind === kind)
    && (!query.trim() || d.title.toLowerCase().includes(query.trim().toLowerCase())));
  const open = (id: string) => setCurrentServer(navigate.moduleRoute(ROUTE, id));

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)', ...style }}>
      <div style={{ maxWidth: 1040, margin: '0 auto', padding: '20px 20px 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, flex: 1, fontSize: 22, fontWeight: 800, color: 'var(--text-primary)' }}>{t('of_title')}</h1>
          <Button kind="primary" onClick={() => setCreating(true)}><Plus size={15} /> {t('of_new')}</Button>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
          <Segmented value={kind} onChange={setKind} options={[
            { id: 'all', label: t('of_all') },
            { id: 'doc', label: t('of_kind_doc'), icon: KIND_ICON.doc },
            { id: 'sheet', label: t('of_kind_sheet'), icon: KIND_ICON.sheet },
            { id: 'deck', label: t('of_kind_deck'), icon: KIND_ICON.deck },
          ]} />
          <div style={{ position: 'relative', flex: 1, minWidth: 170, maxWidth: 280 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--text-tertiary)' }} />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('of_search')}
              style={{ ...inputStyle(), paddingLeft: 30 }} />
          </div>
        </div>
        {loaded && shown.length === 0 ? (
          <Empty icon={<FileText size={28} />} title={t('of_empty')} hint={t('of_empty_hint')}
            action={<Button kind="primary" onClick={() => setCreating(true)}>{t('of_new')}</Button>} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 12 }}>
            {shown.map(d => <DocCard key={d.id} doc={d} onOpen={() => open(d.id)} />)}
          </div>
        )}
      </div>
      {creating && (
        <CreateDialog onClose={() => setCreating(false)}
          onCreated={doc => { setCreating(false); void office.refresh(); open(doc.id); }} />
      )}
    </div>
  );
}

export type { UserBrief };
