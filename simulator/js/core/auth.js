/*
 * PIN authentication.
 *  - Verifier = SHA-256(first half of PBKDF2-HMAC-SHA256(pin, salt, iter, 64 bytes))
 *  - Second half of the derived material is the data key used to encrypt the
 *    private vault (history/favorites) – it only exists in RAM while unlocked.
 *  - The PIN itself is never stored or logged.
 *  - Failed attempts are persisted; after maxAttempts the device locks out
 *    with exponential backoff.
 * The crypto provider is injected (WebCrypto in the simulator, mbedTLS/PSA
 * on the ESP32-S3 – see firmware/components/authentication).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.MT = root.MT || {}; root.MT.Auth = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_POLICY = { minLen: 6, maxLen: 8, iterations: 100000, maxAttempts: 5, baseLockMs: 30000, maxLockMs: 3600000 };

  const b64 = {
    enc(u8) { let s = ''; u8.forEach(b => { s += String.fromCharCode(b); }); return typeof btoa === 'function' ? btoa(s) : Buffer.from(u8).toString('base64'); },
    dec(str) {
      if (typeof atob === 'function') { const s = atob(str); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
      return new Uint8Array(Buffer.from(str, 'base64'));
    }
  };

  function ctEqual(a, b) {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }

  function validPin(pin, policy) {
    return typeof pin === 'string' && /^[0-9]+$/.test(pin) && pin.length >= policy.minLen && pin.length <= policy.maxLen;
  }

  class Auth {
    constructor({ crypto, storage, now, policy }) {
      this.crypto = crypto;
      this.storage = storage;
      this.now = now || (() => Date.now());
      this.policy = Object.assign({}, DEFAULT_POLICY, policy || {});
    }

    hasPin() { return !!this.storage.get('auth.verifier'); }

    attempts() {
      const raw = this.storage.get('auth.attempts');
      try { return raw ? JSON.parse(raw) : { failures: 0, lockUntil: 0 }; } catch (e) { return { failures: 0, lockUntil: 0 }; }
    }
    saveAttempts(a) { this.storage.set('auth.attempts', JSON.stringify(a)); }

    lockRemainingMs() { return Math.max(0, this.attempts().lockUntil - this.now()); }
    isLocked() { return this.lockRemainingMs() > 0; }

    async derive(pin, salt, iterations) {
      const bits = await this.crypto.pbkdf2(pin, salt, iterations, 64);
      const check = await this.crypto.sha256(bits.slice(0, 32));
      const dataKey = bits.slice(32, 64);
      bits.fill(0);
      return { check, dataKey };
    }

    /** Create or replace the PIN. Returns the new data key. */
    async setPin(pin) {
      if (!validPin(pin, this.policy)) throw new Error('PIN deve ter de ' + this.policy.minLen + ' a ' + this.policy.maxLen + ' digitos');
      const salt = this.crypto.randomBytes(16);
      const { check, dataKey } = await this.derive(pin, salt, this.policy.iterations);
      this.storage.set('auth.verifier', JSON.stringify({ v: 1, alg: 'PBKDF2-SHA256', iter: this.policy.iterations, salt: b64.enc(salt), check: b64.enc(check) }));
      this.saveAttempts({ failures: 0, lockUntil: 0 });
      return dataKey;
    }

    /** Verify a PIN. Never throws for wrong PINs. */
    async verify(pin) {
      if (this.isLocked()) return { ok: false, locked: true, remainingMs: this.lockRemainingMs() };
      const raw = this.storage.get('auth.verifier');
      if (!raw) return { ok: false, noPin: true };
      let ver;
      try { ver = JSON.parse(raw); } catch (e) { return { ok: false, corrupt: true }; }
      let ok = false, dataKey = null;
      if (validPin(pin, this.policy)) {
        const d = await this.derive(pin, b64.dec(ver.salt), ver.iter);
        ok = ctEqual(d.check, b64.dec(ver.check));
        if (ok) dataKey = d.dataKey; else d.dataKey.fill(0);
      }
      const a = this.attempts();
      if (ok) { this.saveAttempts({ failures: 0, lockUntil: 0 }); return { ok: true, dataKey }; }
      a.failures++;
      if (a.failures >= this.policy.maxAttempts) {
        const k = a.failures - this.policy.maxAttempts;
        a.lockUntil = this.now() + Math.min(this.policy.maxLockMs, this.policy.baseLockMs * Math.pow(2, k));
      }
      this.saveAttempts(a);
      return { ok: false, failures: a.failures, locked: a.lockUntil > this.now() };
    }

    clearPin() { this.storage.remove('auth.verifier'); this.saveAttempts({ failures: 0, lockUntil: 0 }); }
  }

  /** Encrypted vault (AES-256-GCM) for private data. */
  class Vault {
    constructor({ crypto, storage, key = 'vault' }) { this.crypto = crypto; this.storage = storage; this.key = key; this.data = null; this.dataKey = null; }
    static empty() { return { v: 1, history: [], favorites: [] }; }
    async open(dataKey) {
      this.dataKey = dataKey;
      const raw = this.storage.get(this.key);
      if (!raw) { this.data = Vault.empty(); return this.data; }
      try {
        const o = JSON.parse(raw);
        const pt = await this.crypto.aesGcmDecrypt(dataKey, b64.dec(o.iv), b64.dec(o.ct));
        this.data = JSON.parse(new TextDecoder().decode(pt));
      } catch (e) {
        this.data = Vault.empty(); // wrong key or corrupted: start empty, keep blob untouched
        this.corrupt = true;
      }
      return this.data;
    }
    async save() {
      if (!this.dataKey || !this.data) return false;
      const key = this.dataKey.slice(); // snapshot: a privacy lock may wipe dataKey meanwhile
      const iv = this.crypto.randomBytes(12);
      const pt = new TextEncoder().encode(JSON.stringify(this.data));
      let ct;
      try { ct = await this.crypto.aesGcmEncrypt(key, iv, pt); } finally { pt.fill(0); key.fill(0); }
      this.storage.set(this.key, JSON.stringify({ v: 1, iv: b64.enc(iv), ct: b64.enc(ct) }));
      return true;
    }
    async rekey(newKey) { this.dataKey = newKey; return this.save(); }
    close() {
      if (this.dataKey) this.dataKey.fill(0);
      this.dataKey = null;
      this.data = null;
    }
    get isOpen() { return !!this.data; }
  }

  return { Auth, Vault, DEFAULT_POLICY, ctEqual, validPin, b64 };
});
