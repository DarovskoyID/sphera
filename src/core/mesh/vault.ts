/** Client-only personal archive keys. No password, root key or plaintext is sent here.
 * This module is not a dialogue/group E2EE protocol or login authentication.
 */
import { argon2id } from 'hash-wasm';

export type Vault = { version: 1; profile: 'argon2id-64m-t3-p1'; userId: string; salt: string; nonce: string; wrappedRoot: string };
export type ArchiveMessage = { version: 1; userId: string; dialogId: string; messageId: string; nonce: string; ciphertext: string };
const encoder = new TextEncoder();
const profile = 'argon2id-64m-t3-p1' as const;
const hex = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const buffer = (value: Uint8Array): ArrayBuffer => new Uint8Array(value).buffer;
const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
function bytes(value: string, length?: number): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(value) || (length !== undefined && value.length !== length * 2)) throw new Error('invalid_encoding');
  return Uint8Array.from(value.match(/../g) || [], pair => parseInt(pair, 16));
}
function identifier(value: string) {
  if (typeof value !== 'string' || !value.length || value.length > 256) throw new Error('invalid_identity');
}
function aad(kind: string, ...ids: string[]) {
  ids.forEach(identifier);
  return encoder.encode(JSON.stringify(['sfera-mesh', 1, kind, ...ids]));
}
async function passwordKey(password: string, salt: Uint8Array) {
  if (typeof password !== 'string' || !password.length || password.length > 4096) throw new Error('invalid_password');
  const derived = await argon2id({ password, salt, parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32, outputType: 'binary' });
  try { return await crypto.subtle.importKey('raw', derived.buffer as ArrayBuffer, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  finally { derived.fill(0); }
}
async function wrap(root: Uint8Array, userId: string, password: string): Promise<Vault> {
  if (root.length !== 32) throw new Error('invalid_root');
  const salt = random(16), nonce = random(12);
  const key = await passwordKey(password, salt);
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce.buffer as ArrayBuffer, additionalData: aad('root', userId, profile).buffer as ArrayBuffer }, key, buffer(root));
  return { version: 1, profile, userId, salt: hex(salt), nonce: hex(nonce), wrappedRoot: hex(new Uint8Array(wrapped)) };
}
export async function createVault(userId: string, password: string): Promise<{ vault: Vault; root: Uint8Array }> {
  identifier(userId);
  const root = random(32);
  try { return { vault: await wrap(root, userId, password), root }; }
  catch (error) { root.fill(0); throw error; }
}
export async function unlockVault(value: Vault, expectedUserId: string, password: string): Promise<Uint8Array> {
  if (!value || value.version !== 1 || value.profile !== profile || value.userId !== expectedUserId || Object.keys(value).sort().join(',') !== 'nonce,profile,salt,userId,version,wrappedRoot') throw new Error('invalid_vault');
  const salt = bytes(value.salt, 16), nonce = bytes(value.nonce, 12), ciphertext = bytes(value.wrappedRoot, 48);
  const key = await passwordKey(password, salt);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce.buffer as ArrayBuffer, additionalData: aad('root', expectedUserId, profile).buffer as ArrayBuffer }, key, ciphertext.buffer as ArrayBuffer));
}
export async function changeVaultPassword(value: Vault, userId: string, oldPassword: string, newPassword: string): Promise<Vault> {
  const root = await unlockVault(value, userId, oldPassword);
  try { return await wrap(root, userId, newPassword); }
  finally { root.fill(0); }
}
async function archiveKey(root: Uint8Array, userId: string, dialogId: string, messageId: string) {
  if (root.length !== 32) throw new Error('invalid_root');
  const material = await crypto.subtle.importKey('raw', buffer(root), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('sfera-archive-v1'), info: aad('message', userId, dialogId, messageId).buffer as ArrayBuffer }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptArchive(root: Uint8Array, userId: string, dialogId: string, messageId: string, plaintext: Uint8Array): Promise<ArchiveMessage> {
  if (plaintext.length > 1024 * 1024) throw new Error('message_too_large');
  const nonce = random(12), key = await archiveKey(root, userId, dialogId, messageId);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce.buffer as ArrayBuffer, additionalData: aad('message', userId, dialogId, messageId).buffer as ArrayBuffer }, key, buffer(plaintext));
  return { version: 1, userId, dialogId, messageId, nonce: hex(nonce), ciphertext: hex(new Uint8Array(encrypted)) };
}
export async function decryptArchive(root: Uint8Array, userId: string, dialogId: string, messageId: string, message: ArchiveMessage): Promise<Uint8Array> {
  if (!message || message.version !== 1 || message.userId !== userId || message.dialogId !== dialogId || message.messageId !== messageId || typeof message.ciphertext !== 'string' || message.ciphertext.length > (1024 * 1024 + 16) * 2) throw new Error('invalid_message_context');
  const nonce = bytes(message.nonce, 12), ciphertext = bytes(message.ciphertext);
  const key = await archiveKey(root, userId, dialogId, messageId);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce.buffer as ArrayBuffer, additionalData: aad('message', userId, dialogId, messageId).buffer as ArrayBuffer }, key, ciphertext.buffer as ArrayBuffer));
}
