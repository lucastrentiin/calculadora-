/** Per-device rate limiting (token bucket) and daily quota. In-memory. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number; day: string; used: number }>();
  private perMinute: number;
  private daily: number;
  private now: () => number;
  constructor(perMinute: number, daily: number, now: () => number = () => Date.now()) {
    this.perMinute = perMinute; this.daily = daily; this.now = now;
  }
  /** Returns 0 when allowed, otherwise seconds to wait. */
  take(id: string): { ok: boolean; retryAfter: number; reason?: string } {
    const now = this.now();
    const day = new Date(now).toISOString().slice(0, 10);
    let b = this.buckets.get(id);
    if (!b) { b = { tokens: this.perMinute, at: now, day, used: 0 }; this.buckets.set(id, b); }
    if (b.day !== day) { b.day = day; b.used = 0; }
    b.tokens = Math.min(this.perMinute, b.tokens + ((now - b.at) / 60000) * this.perMinute);
    b.at = now;
    if (b.used >= this.daily) return { ok: false, retryAfter: 3600, reason: 'cota diaria esgotada' };
    if (b.tokens < 1) return { ok: false, retryAfter: Math.ceil(((1 - b.tokens) * 60) / this.perMinute), reason: 'muitas requisicoes' };
    b.tokens -= 1;
    b.used += 1;
    return { ok: true, retryAfter: 0 };
  }
}

/** Basic JPEG validation: SOI/EOI markers and frame dimensions from SOFn. */
export function inspectJpeg(buf: Uint8Array): { ok: true; width: number; height: number } | { ok: false; error: string } {
  if (buf.length < 64) return { ok: false, error: 'imagem muito pequena' };
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return { ok: false, error: 'nao e JPEG' };
  let end = buf.length;
  while (end > 2 && buf[end - 1] === 0x00) end--; // some encoders pad with zeros
  if (buf[end - 2] !== 0xff || buf[end - 1] !== 0xd9) return { ok: false, error: 'JPEG incompleto' };
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (len < 2) return { ok: false, error: 'segmento invalido' };
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      const height = (buf[i + 5] << 8) | buf[i + 6];
      const width = (buf[i + 7] << 8) | buf[i + 8];
      if (!width || !height) return { ok: false, error: 'dimensoes invalidas' };
      return { ok: true, width, height };
    }
    if (marker === 0xda) break; // start of scan without frame header
    i += 2 + len;
  }
  return { ok: false, error: 'cabecalho SOF ausente' };
}
