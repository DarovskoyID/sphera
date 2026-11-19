/** Authenticated local epoch checkpoints. A whole-profile rollback still needs
 * an independently fresh network checkpoint; local encryption cannot prove time.
 */
type Head = { epoch: number; room: string };
type Sealed = { iv: string; ciphertext: string };
type Prepared = { digest: string; body: string };
const encoder = new TextEncoder();
const encode = (value: Uint8Array) => {
  let text = '';
  for (let offset = 0; offset < value.length; offset += 8192) text += String.fromCharCode(...value.subarray(offset, offset + 8192));
  return btoa(text);
};
const decode = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));

export class CipherCheckpoints {
  private constructor(privateDb: IDBDatabase, privateKey: CryptoKey, context: string) {
    this.db = privateDb; this.key = privateKey; this.context = context;
  }
  private db: IDBDatabase;
  private key: CryptoKey;
  private context: string;

  static async open(context: string, passphrase: string) {
    if (typeof indexedDB === 'undefined') throw new Error('encrypted_cipher_store_unavailable');
    const name = 'sphere-e2ee-heads-v1:' + context;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = () => {
        for (const store of ['config', 'heads', 'outgoing']) {
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('encrypted_cipher_store_unavailable'));
      request.onblocked = () => reject(new Error('encrypted_cipher_store_blocked'));
    });
    try {
      const salt = await new Promise<Uint8Array>((resolve, reject) => {
        const transaction = db.transaction('config', 'readwrite');
        const store = transaction.objectStore('config');
        const request = store.get('salt');
        let result: Uint8Array;
        request.onsuccess = () => {
          try {
            if (request.result === undefined) {
              result = crypto.getRandomValues(new Uint8Array(32)); store.add(encode(result), 'salt');
            } else {
              if (typeof request.result !== 'string' || request.result.length !== 44) throw new Error();
              result = decode(request.result);
              if (result.length !== 32) throw new Error();
            }
          } catch { transaction.abort(); }
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = transaction.onerror = () => reject(new Error('cipher_checkpoint_salt_corrupt'));
      });
      const secret = encoder.encode(passphrase);
      let material: CryptoKey;
      try { material = await crypto.subtle.importKey('raw', secret.buffer, 'PBKDF2', false, ['deriveKey']); }
      finally { secret.fill(0); }
      const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: 310000,
        salt: new Uint8Array(salt).buffer }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      return new CipherCheckpoints(db, key, context);
    } catch (error) { db.close(); throw error; }
  }

  private read(scope: string) {
    return new Promise<Sealed | undefined>((resolve, reject) => {
      const transaction = this.db.transaction('heads', 'readonly');
      const request = transaction.objectStore('heads').get(scope);
      let result: Sealed | undefined;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = transaction.onerror = () => reject(new Error('cipher_checkpoint_read_failed'));
    });
  }

  private async unseal(scope: string, value: Sealed): Promise<Head> {
    try {
      if (!value || Object.keys(value).sort().join(',') !== 'ciphertext,iv' ||
          typeof value.iv !== 'string' || value.iv.length !== 16 || typeof value.ciphertext !== 'string' || value.ciphertext.length > 2048) throw new Error();
      const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(value.iv).buffer,
        additionalData: encoder.encode(this.context + ':' + scope).buffer }, this.key, decode(value.ciphertext).buffer);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      const body = JSON.parse(text);
      if (Object.keys(body).sort().join(',') !== 'epoch,room' || !Number.isSafeInteger(body.epoch) || body.epoch < 1 ||
          typeof body.room !== 'string' || !/^![0-9a-f]{64}:[0-9a-f]{64}\.sphere$/.test(body.room)) throw new Error();
      return body;
    } catch { throw new Error('cipher_checkpoint_corrupt'); }
  }

  private compareAndSet(scope: string, previous: Sealed | undefined, next: Sealed) {
    return new Promise<boolean>((resolve, reject) => {
      const transaction = this.db.transaction('heads', 'readwrite');
      const store = transaction.objectStore('heads');
      const request = store.get(scope);
      let conflict = false;
      request.onsuccess = () => {
        if (JSON.stringify(request.result) !== JSON.stringify(previous)) {
          conflict = true; transaction.abort(); return;
        }
        store.put(next, scope);
      };
      transaction.oncomplete = () => resolve(true);
      transaction.onabort = () => conflict ? resolve(false) : reject(new Error('cipher_checkpoint_write_failed'));
      transaction.onerror = () => reject(new Error('cipher_checkpoint_write_failed'));
    });
  }

  async advance(scope: string, head: Head) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const sealed = await this.read(scope);
      if (sealed) {
        const old = await this.unseal(scope, sealed);
        if (old.epoch > head.epoch || (old.epoch === head.epoch && old.room !== head.room)) throw new Error('group_membership_rollback_or_fork');
        if (old.epoch === head.epoch) return;
      }
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv.buffer,
        additionalData: encoder.encode(this.context + ':' + scope).buffer }, this.key, encoder.encode(JSON.stringify(head)).buffer);
      if (await this.compareAndSet(scope, sealed, { iv: encode(iv), ciphertext: encode(new Uint8Array(encrypted)) })) return;
    }
    throw new Error('cipher_checkpoint_concurrent_update');
  }

  async prepared(id: string): Promise<Prepared | undefined> {
    const sealed = await new Promise<Sealed | undefined>((resolve, reject) => {
      const tx = this.db.transaction('outgoing', 'readonly');
      const request = tx.objectStore('outgoing').get(id);
      let result: Sealed | undefined;
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(new Error('cipher_outgoing_read_failed'));
    });
    if (!sealed) return undefined;
    try {
      if (Object.keys(sealed).sort().join(',') !== 'ciphertext,iv' || typeof sealed.iv !== 'string' || sealed.iv.length !== 16 ||
          typeof sealed.ciphertext !== 'string' || sealed.ciphertext.length > 400000) throw new Error();
      const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(sealed.iv).buffer,
        additionalData: encoder.encode(this.context + ':outgoing:' + id).buffer }, this.key, decode(sealed.ciphertext).buffer);
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      if (Object.keys(result).sort().join(',') !== 'body,digest' || typeof result.digest !== 'string' || !/^[0-9a-f]{64}$/.test(result.digest) ||
          typeof result.body !== 'string' || encoder.encode(result.body).length > 262144) throw new Error();
      return result;
    } catch { throw new Error('cipher_outgoing_corrupt'); }
  }

  async prepare(id: string, value: Prepared) {
    if (typeof id !== 'string' || !id || id.length > 256 || !/^[0-9a-f]{64}$/.test(value.digest) ||
        typeof value.body !== 'string' || encoder.encode(value.body).length > 262144) throw new Error('invalid_cipher_outgoing');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(JSON.stringify(value));
    if (plaintext.length > 262144) throw new Error('cipher_outgoing_too_large');
    const raw = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv.buffer,
      additionalData: encoder.encode(this.context + ':outgoing:' + id).buffer }, this.key, plaintext.buffer);
    const sealed = { iv: encode(iv), ciphertext: encode(new Uint8Array(raw)) };
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction('outgoing', 'readwrite'), store = tx.objectStore('outgoing');
      const request = store.count();
      request.onsuccess = () => {
        if (request.result >= 128) { tx.abort(); return; }
        store.add(sealed, id);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('cipher_outgoing_capacity_or_conflict'));
    });
  }

  async forgetPrepared(id: string) {
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction('outgoing', 'readwrite');
      tx.objectStore('outgoing').delete(id);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('cipher_outgoing_write_failed'));
    });
  }

  close() { this.db.close(); }
}
