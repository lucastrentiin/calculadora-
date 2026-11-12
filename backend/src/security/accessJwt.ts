/**
 * Cloudflare Access JWT verification (Cf-Access-Jwt-Assertion header).
 * Cloudflare signs with RS256; public keys at https://<team>/cdn-cgi/access/certs.
 * Verification: signature (node:crypto), iss, aud, exp/nbf. Keys cached 1 h.
 */
import { createPublicKey, verify as cverify, type JsonWebKey } from 'node:crypto';

export interface AccessClaims { aud: string | string[]; iss: string; exp: number; nbf?: number; email?: string; common_name?: string; sub?: string; type?: string }

type Fetcher = (url: string) => Promise<{ keys: (JsonWebKey & { kid?: string })[] }>;

export class AccessVerifier {
  private keys = new Map<string, ReturnType<typeof createPublicKey>>();
  private fetchedAt = 0;
  private team: string;
  private fetcher: Fetcher;
  private now: () => number;
  constructor(teamDomain: string, fetcher?: Fetcher, now: () => number = () => Date.now()) {
    this.team = teamDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.fetcher = fetcher ?? (async (u) => { const r = await fetch(u); if (!r.ok) throw new Error('JWKS HTTP ' + r.status); return r.json() as Promise<{ keys: JsonWebKey[] }>; });
    this.now = now;
  }
  private async refresh(force = false): Promise<void> {
    if (!force && this.now() - this.fetchedAt < 3600_000 && this.keys.size) return;
    const jwks = await this.fetcher(`https://${this.team}/cdn-cgi/access/certs`);
    this.keys.clear();
    for (const k of jwks.keys) if (k.kid) this.keys.set(k.kid, createPublicKey({ key: k, format: 'jwk' }));
    this.fetchedAt = this.now();
  }
  async verify(jwt: string | undefined, audience: string | undefined): Promise<AccessClaims> {
    if (!jwt) throw new Error('token do Access ausente');
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new Error('token malformado');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as { alg: string; kid: string };
    if (header.alg !== 'RS256') throw new Error('algoritmo nao permitido');
    await this.refresh();
    let key = this.keys.get(header.kid);
    if (!key) { await this.refresh(true); key = this.keys.get(header.kid); }
    if (!key) throw new Error('chave desconhecida');
    const ok = cverify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new Error('assinatura invalida');
    const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as AccessClaims;
    const nowS = Math.floor(this.now() / 1000);
    if (c.iss !== `https://${this.team}`) throw new Error('emissor invalido');
    const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (audience && !auds.includes(audience)) throw new Error('audiencia invalida');
    if (typeof c.exp !== 'number' || c.exp < nowS - 30) throw new Error('token expirado');
    if (c.nbf && c.nbf > nowS + 30) throw new Error('token ainda nao valido');
    return c;
  }
}
