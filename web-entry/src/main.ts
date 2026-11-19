import { accountBytes, accountDigest, createMeshAccount, openMeshAccount, verifyAccount, type AccountRecord } from './mesh/account';
import { loginNonce, answerLogin, verifyLoginSession, verifySessionState, verifyLogout, type LoginSession } from './mesh/auth';
import type { Vault } from './mesh/vault';
import './style.css';

type Saved = { format: 'sphere-web-account-v1'; nickname: string; network: string; record: AccountRecord; vault: Vault };
type Info = { network: string; nodeId: string; publicKey: string; label: string; ready: boolean; height: number; peers: { label: string; url: string; nodeId: string }[] };
const app = document.querySelector<HTMLDivElement>('#app')!;
let info: Info, saved: Saved | null = null, session: LoginSession | null = null, mode = 'login', busy = false;
const storageKey = 'sphere-web-account-v1';
const html = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
async function request(path: string, body?: unknown, token?: string) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(25000), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'request_failed');
  return result;
}
function notify(message: string, error = false) { const n = document.querySelector<HTMLElement>('#notice')!; n.textContent = message; n.className = error ? 'notice error' : 'notice'; }
function download() {
  if (!saved) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(saved)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `sphere-account-${saved.record.body.user_id.slice(0, 12)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function validate(value: unknown): Promise<Saved> {
  const file = value as Saved;
  if (!file || file.format !== 'sphere-web-account-v1' || file.network !== info.network || typeof file.nickname !== 'string' || file.nickname.length > 64 || !file.vault) throw Error('invalid_account_file');
  await verifyAccount(file.record, info.network);
  if (await accountDigest(accountBytes(file.vault)) !== file.record.body.vault_digest) throw Error('invalid_account_file');
  return file;
}
async function authenticate(password: string) {
  if (!saved) throw Error('account_file_required');
  const root = await openMeshAccount(saved.record, accountBytes(saved.vault), password, info.network, saved.record.body.user_id);
  try {
    let remote;
    try { remote = await request('/web-api/account?user=' + saved.record.body.user_id); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'not_found') throw error;
      await request('/web-api/register', saved.record);
      remote = await request('/web-api/account?user=' + saved.record.body.user_id);
    }
    if (await verifyAccount(remote.record, info.network, saved.record.body.user_id) !== await accountDigest(accountBytes(saved.record))) throw Error('account_changed');
    const nonce = loginNonce(); let challenge;
    for (let attempt = 0; attempt < 8; attempt++) {
      try { challenge = await request('/mesh/auth/challenge', { user_id: saved.record.body.user_id, client_nonce: nonce }); break; }
      catch (error) { if (!(error instanceof Error) || error.message !== 'mesh_directory_unavailable' || attempt === 7) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    const proof = await answerLogin(root, challenge, info, saved.record, saved.record.body.user_id, nonce);
    session = await verifyLoginSession(await request('/mesh/auth/complete', proof), info, challenge, saved.record, saved.record.body.user_id, nonce);
  } finally { root.fill(0); }
}

function render() {
  app.innerHTML = `<div class="shell"><header><a class="brand" href="/" aria-label="Сфера"><span class="orb"></span>сфера<span class="web-label">web</span></a><span class="connection"><i></i>${html(info.label)}</span></header><main><section class="intro"><span class="eyebrow">ВАШЕ ПРОСТРАНСТВО В СЕТИ</span><h1>Ближе друг<br>к другу<span>.</span></h1><p>Одна учётная запись.<br>Вход через любой поинт Сферы.</p><div class="network-line"><span class="mini-orb"></span><span>Сеть работает<small>${info.peers.length} поинтов · защищённое соединение</small></span></div></section><section class="panel">${session ? `<span class="eyebrow">ВЫ В СФЕРЕ</span><h2>Привет, ${html(saved!.nickname || 'друг')}.</h2><p class="muted">Вход через ${html(info.label)} подтверждён.</p><div class="identity"><small>Ваша учётная запись</small><code>${saved!.record.body.user_id}</code></div><button id="export" class="primary">Сохранить ключ входа <span>↓</span></button><p class="hint">Этот зашифрованный файл и ваш пароль позволяют войти на другом поинте.</p><button id="logout" class="secondary">Выйти из учётной записи</button>` : `<div class="tabs"><button data-mode="login" class="${mode === 'login' ? 'active' : ''}">Войти</button><button data-mode="create" class="${mode === 'create' ? 'active' : ''}">Создать аккаунт</button></div><h2>${mode === 'create' ? 'Добро пожаловать.' : 'С возвращением.'}</h2><p class="muted">${mode === 'create' ? 'Создайте свою учётную запись в Сфере.' : saved ? `Ключ ${html(saved.nickname || saved.record.body.user_id.slice(0, 10))} сохранён в этом браузере.` : 'Откройте сохранённый ключ входа.'}</p><form id="auth-form">${mode === 'create' ? '<label>Как к вам обращаться<input name="nickname" maxlength="64" required autocomplete="nickname" placeholder="Ваше имя"></label>' : '<label class="file-label">Ключ входа<input id="account-file" type="file" accept=".json,application/json"><span>Выбрать файл ключа <b>↗</b></span></label>'}<label>Пароль<input name="password" type="password" required minlength="${mode === 'create' ? 12 : 1}" maxlength="4096" autocomplete="${mode === 'create' ? 'new-password' : 'current-password'}" placeholder="${mode === 'create' ? 'Не менее 12 символов' : 'Пароль к вашему ключу'}"></label>${mode === 'create' ? '<label>Повторите пароль<input name="confirmation" type="password" required minlength="12" autocomplete="new-password" placeholder="Ещё раз"></label>' : ''}<button class="primary" type="submit">${mode === 'create' ? 'Создать аккаунт' : 'Войти в Сферу'} <span>→</span></button></form><p class="hint">Ключи создаются в браузере. Пароль остаётся у вас.</p>`}<p id="notice" class="notice" role="status" aria-live="polite"></p></section></main><section class="points"><div><span class="eyebrow">ТОЧКИ ВХОДА</span><h3>Выберите, откуда войти.</h3></div><div class="point-list">${info.peers.map(p => `<a href="${html(p.url)}" class="point ${p.nodeId === info.nodeId ? 'current' : ''}"><span class="point-dot"></span>${html(p.label)}<span>${p.nodeId === info.nodeId ? 'Вы здесь' : '↗'}</span></a>`).join('')}</div><p class="hint">На другом поинте откройте файл ключа и введите пароль.</p></section><footer><span>Сфера · веб-вход</span><span>Ваш ключ. Ваша учётная запись.</span></footer></div>`;
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.onclick = () => { if (!busy) { mode = button.dataset.mode!; render(); } });
  document.querySelector<HTMLInputElement>('#account-file')?.addEventListener('change', async event => { try { const file = (event.target as HTMLInputElement).files?.[0]; if (!file || file.size > 16384) throw Error('invalid_account_file'); saved = await validate(JSON.parse(await file.text())); localStorage.setItem(storageKey, JSON.stringify(saved)); localStorage.setItem(storageKey + ":" + saved.record.body.user_id, JSON.stringify(saved)); render(); notify('Ключ открыт. Введите пароль.'); } catch { notify('Не удалось открыть ключ. Выберите файл Сферы.', true); } });
  document.querySelector<HTMLFormElement>('#auth-form')?.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return; busy = true; const form = event.target as HTMLFormElement, data = new FormData(form), password = String(data.get('password') || ''); form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(e => e.disabled = true);
    try {
      notify(mode === 'create' ? 'Создаём и подтверждаем учётную запись…' : 'Проверяем ключ и вход…');
      if (mode === 'create') {
        if (password !== data.get('confirmation')) throw Error('password_confirmation');
        const created = await createMeshAccount(password, info.network, await accountDigest(accountBytes([])));
        try { saved = { format: 'sphere-web-account-v1', nickname: String(data.get('nickname')).trim(), network: info.network, record: created.record, vault: created.vault }; localStorage.setItem(storageKey, JSON.stringify(saved)); localStorage.setItem(storageKey + ":" + saved.record.body.user_id, JSON.stringify(saved)); await request('/web-api/register', created.record); }
        finally { created.root.fill(0); }
      }
      await authenticate(password); render(); notify('Вход подтверждён. Сохраните ключ для входа с других устройств.');
    } catch (error) { const message = error instanceof Error ? error.message : ''; notify(message === 'password_confirmation' ? 'Пароли должны совпадать.' : message === 'account_file_required' ? 'Откройте файл ключа входа.' : message === 'account_changed' ? 'Учётная запись обновлена. Откройте актуальный ключ входа.' : message.includes('account_not_confirmed') ? 'Учётная запись ещё не подтверждена. Повторите вход через несколько секунд.' : 'Не удалось войти. Проверьте пароль и ключ или повторите позже.', true); }
    finally { busy = false; form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(e => e.disabled = false); }
  });
  document.querySelector<HTMLButtonElement>('#export')?.addEventListener('click', download);
  document.querySelector<HTMLButtonElement>('#logout')?.addEventListener('click', async () => { try { const nonce = loginNonce(); await verifyLogout(await request('/mesh/auth/logout', { client_nonce: nonce }, session!.token), info, session!.user_id, session!.session_id, nonce); session = null; render(); } catch { notify('Не удалось подтвердить выход. Повторите.', true); } });
}
async function boot() {
  try { info = await request('/web-api/info'); if (!info.ready) throw Error('point_not_ready'); const local = localStorage.getItem(storageKey); if (local) { try { saved = await validate(JSON.parse(local)); } catch { saved = null; } } render(); }
  catch { app.innerHTML = '<div class="loading"><span class="orb"></span><h1>Поинт подключается</h1><p>Повторим проверку через несколько секунд.</p></div>'; setTimeout(boot, 5000); }
}
setInterval(async () => { if (!session) return; try { const nonce = loginNonce(); await verifySessionState(await request('/mesh/auth/session', { client_nonce: nonce }, session.token), info, session.user_id, session.session_id, nonce); } catch { session = null; render(); notify('Сессия завершилась. Войдите снова.'); } }, 30000);
void boot();
