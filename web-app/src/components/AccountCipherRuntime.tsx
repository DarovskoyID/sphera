import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../context/AppContext';
import { DmCipherSession } from '../core/mesh/dmCipherSession';
import type { ApplicationKeys } from '../core/mesh/applicationAuth';
import type { TrustedEntryPoint } from '../core/mesh/entryPoint';
import {applicationDeviceAccess,restoreApplicationDevice} from '../core/mesh/applicationActions';
import { ENTRY_PIN_KEY,loadEntryPointPin } from '../core/mesh/entryPoint';
import type { CipherScopeBody } from '../core/mesh/cipherPolicy';

type Reviewer = (body: CipherScopeBody) => Promise<boolean>;
function useRuntime() {
  const { currentServerIP, authToken, userIDonServer, currentUser } = useApp();
  const identity = JSON.stringify([currentServerIP, authToken, userIDonServer]);
  const actor = useRef(identity); actor.current = identity;
  const token = useRef(authToken); token.current = authToken;
  const session = useRef<DmCipherSession | null>(null), closing = useRef<Promise<void>>(Promise.resolve());
  const revision = useRef(0), opening = useRef(false), reviewer = useRef<{ owner: object; review: Reviewer } | null>(null);
  const [openedFor, setOpenedFor] = useState('');
  const [unlockState, setUnlockState] = useState<'opening'|'sign-in'|'retry'|'recovery'>('opening');
  const [retry, setRetry] = useState(0);
  const lock = () => {
    revision.current++;
    const old = session.current; session.current = null; setOpenedFor('');
    closing.current = closing.current.then(() => old?.close()).catch(() => undefined);
  };
  useEffect(() => {
    lock();
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === ENTRY_PIN_KEY || event.key === 'sfera_selected_server' ||
          event.key === 'authToken' && event.newValue === null) lock();
    };
    window.addEventListener('storage', storage); window.addEventListener('sfera-mesh-entry-change', lock);
    return () => { lock(); window.removeEventListener('storage', storage); window.removeEventListener('sfera-mesh-entry-change', lock); };
  }, [identity]);
  useEffect(() => {
    if (openedFor !== identity) return;
    try {
      const jwt = JSON.parse(atob(authToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (!Number.isSafeInteger(jwt.exp)) return;
      const timer = setTimeout(lock, Math.max(0, Math.min(2147483647, jwt.exp * 1000 - Date.now())));
      return () => clearTimeout(timer);
    } catch { /* Session unlock independently validates the mesh token. */ }
  }, [identity, openedFor]);
  const open=async (keys: ApplicationKeys, pin: TrustedEntryPoint, password: string, archiveKey?: { file: unknown; password: string }, profileGuard = false,distributed=false) => {
      if (opening.current || session.current) throw new Error('cipher_session_already_open');
      opening.current = true;
      const captured = identity, generation = revision.current, pinText = localStorage.getItem(ENTRY_PIN_KEY);
      const guard = () => actor.current === captured && generation === revision.current && localStorage.getItem(ENTRY_PIN_KEY) === pinText;
      let opened: DmCipherSession | undefined;
      try {
        await closing.current;
        opened = await DmCipherSession.unlock(keys, pin, userIDonServer, password,
          { distributed,guard, archiveKey, profileGuard, token: () => token.current, review: body => guard() && reviewer.current ? reviewer.current.review(body) : Promise.resolve(false) });
        if (!guard()) throw new Error('cipher_context_changed');
        session.current = opened; setOpenedFor(captured); return opened;
      } catch (error) { await opened?.close(); throw error; }
      finally { opening.current = false; }
  };
  useEffect(()=>{
    if(currentUser?.service_capabilities?.mode!=='distributed' || !authToken || !userIDonServer)return;
    setUnlockState('opening');
    let cancelled = false;
    const tryOpen=async()=>{if(cancelled || session.current)return;
      try {await restoreApplicationDevice(currentServerIP,authToken);}
      catch {if(!cancelled)setUnlockState('sign-in');return;}
      if(cancelled)return;
      try {
        const capability=applicationDeviceAccess(currentServerIP,authToken),pin=await loadEntryPointPin(localStorage);
        if(cancelled)return;
        if(!pin || pin.url!==new URL(currentServerIP).origin)throw new Error('entry_pin_required');
        await open(capability.keys,pin,'',undefined,true,true);
      } catch (error) {
        if (cancelled) return;
        const code = error instanceof Error ? error.message : '';
        setUnlockState(code === 'cipher_profile_interrupted' || code === 'cipher_profile_local_mismatch' ? 'recovery' : 'retry');
      }
    };void tryOpen();return()=>{cancelled=true;};
  },[identity,currentUser?.service_capabilities?.mode,retry]);
  return {
    session, closing, ready: openedFor === identity && !!session.current,
    unlockState, retryUnlock: () => setRetry(value=>value+1),
    lock,
    attachReviewer(owner: object, review: Reviewer) {
      reviewer.current = { owner, review };
      return () => { if (reviewer.current?.owner === owner) reviewer.current = null; };
    },
    open,
  };
}
const RuntimeContext = createContext<ReturnType<typeof useRuntime> | null>(null);
export const useAccountCipherRuntime = () => useContext(RuntimeContext);
export function AccountCipherProvider({ children }: { children: ReactNode }) {
  return <RuntimeContext.Provider value={useRuntime()}>{children}</RuntimeContext.Provider>;
}
