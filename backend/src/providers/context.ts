/** Access to configuration and encrypted secrets for provider adapters. */
import type { Config } from '../config/index.ts';
import type { SecretBox } from '../security/crypto.ts';
import type { Db } from '../storage/db.ts';

export interface ProviderSettings {
  enabled: boolean;
  model: string;
  /** owner explicitly confirmed he read the provider terms for this usage */
  acknowledged: boolean;
  authMode?: 'subscription' | 'api_key';
}

export class ProviderContext {
  readonly cfg: Config;
  private db: Db;
  private box: SecretBox;
  constructor(cfg: Config, db: Db, box: SecretBox) { this.cfg = cfg; this.db = db; this.box = box; }
  settings(id: string, def: ProviderSettings): ProviderSettings { return { ...def, ...this.db.getSetting<Partial<ProviderSettings>>('provider.' + id, {}) }; }
  saveSettings(id: string, s: Partial<ProviderSettings>, actor = 'admin'): void {
    const cur = this.db.getSetting<Partial<ProviderSettings>>('provider.' + id, {});
    this.db.setSetting('provider.' + id, { ...cur, ...s });
    this.db.securityLog('provider_settings_changed', actor, id);
  }
  secret(name: string): string | undefined {
    const r = this.db.get<{ value_enc: string }>('SELECT value_enc FROM secrets WHERE name = ?', name);
    return r ? this.box.open(r.value_enc, 'secret:' + name) : undefined;
  }
  setSecret(name: string, value: string | null, actor = 'admin'): void {
    if (value == null || value === '') this.db.run('DELETE FROM secrets WHERE name = ?', name);
    else this.db.run('INSERT INTO secrets (name, value_enc, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at',
      name, this.box.seal(value, 'secret:' + name), Date.now());
    this.db.securityLog(value ? 'secret_set' : 'secret_removed', actor, name);
  }
  hasSecret(name: string): boolean { return !!this.db.get('SELECT name FROM secrets WHERE name = ?', name); }
}
