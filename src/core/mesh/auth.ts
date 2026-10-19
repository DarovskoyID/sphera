/** Local proof-of-possession helpers. No network calls, redirects or token storage.
 * A caller must pin the user-selected entry point's key and trusted HTTPS address.
 */
import { accountBytes, accountDigest, signIdentityStatement, verifyAccount, type AccountRecord } from './account';
export type EntryPointPin = { network: string; nodeId: string; publicKey: string };
export type LoginBody = { domain: 'sfera-mesh-login-v1'; network: string; entry_node: string; user_id: string; account_version: number; account_hash: string; client_nonce: string; challenge_id: string; issued_at: number; expires_at: number };
export type Signed<T> = { body: T; signature: string };
export type LoginSession = { domain: 'sfera-mesh-session-v1'; scope: 'mesh-identity'; network: string; entry_node: string; user_id: string; session_id: string; client_nonce: string; challenge_id: string; issued_at: number; expires_at: number; token: string };
export type SessionState = { domain: 'sfera-mesh-session-state-v1'; scope: 'mesh-identity'; network: string; entry_node: string; user_id: string; session_id: string; client_nonce: string; issued_at: number; expires_at: number; state: 'active' };
export type Logout = { domain: 'sfera-mesh-logout-v1'; network: string; entry_node: string; user_id: string; session_id: string; client_nonce: string; issued_at: number; revoked: true };
const encoder = new TextEncoder();
const buffer = (value: Uint8Array): ArrayBuffer => new Uint8Array(value).buffer;
const hex = (value: Uint8Array) => Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
function fromHex(value: string, length: number) {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/.test(value)) throw new Error('invalid_auth_encoding');
  return Uint8Array.from(value.match(/../g)!, part => parseInt(part, 16));
}
function keys(value: object, fields: string[]) {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== fields.sort().join(',')) throw new Error('invalid_auth_schema');
}
function live(issued: number, expires: number, now: number, duration: number) {
  if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(expires) || issued > now + 5 || expires <= now || expires <= issued || expires > issued + duration) throw new Error('auth_expired_or_invalid_time');
}
function context(body: { network: string; entry_node: string; user_id: string; client_nonce: string }, pin: EntryPointPin, user: string, nonce: string) {
  fromHex(pin.nodeId, 32); fromHex(body.user_id, 32); fromHex(body.client_nonce, 32); fromHex(nonce, 32);
  if (typeof pin.network !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(pin.network) || body.network !== pin.network || body.entry_node !== pin.nodeId || body.user_id !== user || body.client_nonce !== nonce) throw new Error('auth_context_mismatch');
}
async function serverSignature<T extends object>(message: Signed<T>, pin: EntryPointPin) {
  keys(message, ['body', 'signature']);
  const publicBytes = fromHex(pin.publicKey, 32), domain = encoder.encode('sfera-mesh-node-v1\0');
  const combined = new Uint8Array(domain.length + publicBytes.length); combined.set(domain); combined.set(publicBytes, domain.length);
  if (await accountDigest(combined) !== pin.nodeId) throw new Error('entry_point_key_mismatch');
  const publicKey = await crypto.subtle.importKey('raw', buffer(publicBytes), 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', publicKey, buffer(fromHex(message.signature, 64)), buffer(accountBytes(message.body)))) throw new Error('invalid_entry_point_signature');
}
export const loginNonce = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export async function verifyLoginChallenge(message: Signed<LoginBody>, pin: EntryPointPin, record: AccountRecord, user: string, nonce: string, now = Math.floor(Date.now() / 1000)) {
  keys(message, ['body', 'signature']);
  const body = message.body;
  keys(body, ['domain', 'network', 'entry_node', 'user_id', 'account_version', 'account_hash', 'client_nonce', 'challenge_id', 'issued_at', 'expires_at']);
  context(body, pin, user, nonce);
  fromHex(body.challenge_id, 32); fromHex(body.account_hash, 32);
  live(body.issued_at, body.expires_at, now, 60);
  if (body.domain !== 'sfera-mesh-login-v1' || !Number.isSafeInteger(body.account_version) || body.account_version !== record.body.version || body.account_hash !== await verifyAccount(record, pin.network, user)) throw new Error('login_account_mismatch');
  await serverSignature(message, pin);
  return body;
}
export async function answerLogin(root: Uint8Array, message: Signed<LoginBody>, pin: EntryPointPin, record: AccountRecord, user: string, nonce: string, now = Math.floor(Date.now() / 1000)) {
  const body = await verifyLoginChallenge(message, pin, record, user, nonce, now);
  const proof = await signIdentityStatement(root, accountBytes(body));
  const publicKey = await crypto.subtle.importKey('raw', buffer(fromHex(record.body.public_key, 32)), 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', publicKey, buffer(proof), buffer(accountBytes(body)))) throw new Error('login_root_mismatch');
  return { challenge_id: body.challenge_id, signature: hex(proof) };
}
export async function verifyLoginSession(message: Signed<LoginSession>, pin: EntryPointPin, challenge: Signed<LoginBody>, record: AccountRecord, user: string, nonce: string, now = Math.floor(Date.now() / 1000)) {
  // A successful response may arrive just after challenge expiry; verify its
  // signed context, then require issuance within the original challenge window.
  const request = await verifyLoginChallenge(challenge, pin, record, user, nonce, challenge.body.issued_at);
  keys(message, ['body', 'signature']);
  const body = message.body;
  keys(body, ['domain', 'scope', 'network', 'entry_node', 'user_id', 'session_id', 'client_nonce', 'challenge_id', 'issued_at', 'expires_at', 'token']);
  context(body, pin, user, nonce);
  fromHex(body.session_id, 16);
  live(body.issued_at, body.expires_at, now, 600);
  if (body.domain !== 'sfera-mesh-session-v1' || body.scope !== 'mesh-identity' || body.challenge_id !== request.challenge_id || body.issued_at < request.issued_at || body.issued_at >= request.expires_at || typeof body.token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(body.token)) throw new Error('invalid_login_session');
  await serverSignature(message, pin);
  return body;
}
export async function verifySessionState(message: Signed<SessionState>, pin: EntryPointPin, user: string, sessionId: string, nonce: string, now = Math.floor(Date.now() / 1000)) {
  keys(message, ['body', 'signature']);
  const body = message.body;
  keys(body, ['domain', 'scope', 'network', 'entry_node', 'user_id', 'session_id', 'client_nonce', 'issued_at', 'expires_at', 'state']);
  context(body, pin, user, nonce); fromHex(body.session_id, 16);
  live(body.issued_at, body.expires_at, now, 600);
  if (body.domain !== 'sfera-mesh-session-state-v1' || body.scope !== 'mesh-identity' || body.session_id !== sessionId || body.state !== 'active' || body.issued_at < now - 30) throw new Error('invalid_session_state');
  await serverSignature(message, pin);
  return body;
}
export async function verifyLogout(message: Signed<Logout>, pin: EntryPointPin, user: string, sessionId: string, nonce: string, now = Math.floor(Date.now() / 1000)) {
  keys(message, ['body', 'signature']);
  const body = message.body;
  keys(body, ['domain', 'network', 'entry_node', 'user_id', 'session_id', 'client_nonce', 'issued_at', 'revoked']);
  context(body, pin, user, nonce); fromHex(body.session_id, 16);
  if (body.domain !== 'sfera-mesh-logout-v1' || body.revoked !== true || body.session_id !== sessionId || !Number.isSafeInteger(body.issued_at) || body.issued_at < now - 30 || body.issued_at > now + 5) throw new Error('invalid_logout_confirmation');
  await serverSignature(message, pin);
  return body;
}
