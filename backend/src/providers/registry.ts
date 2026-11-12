/**
 * Provider registry and selection policy.
 *  - device may ask for a specific provider id or "auto"
 *  - "auto" = owner's preferred provider if ready, else first ready provider
 *    of the owner-defined automatic order
 *  - NO automatic retry on another (possibly billable) provider unless the
 *    owner enabled `allowFailover` explicitly
 */
import type { Db } from '../storage/db.ts';
import type { AIProvider, ProviderInfo } from './types.ts';

export interface SelectionPolicy { preferred: string; autoOrder: string[]; allowFailover: boolean; deviceVisible: string[] }

export const DEFAULT_POLICY: SelectionPolicy = { preferred: 'mock', autoOrder: ['codex_cli', 'claude_code', 'anthropic_api', 'openai_api', 'mock'], allowFailover: false, deviceVisible: ['codex_cli', 'claude_code', 'anthropic_api', 'openai_api', 'manual', 'mock'] };

const SHORT: Record<string, string> = { codex_cli: 'GPT', openai_api: 'GPT API', claude_code: 'CLAUDE', anthropic_api: 'CLAUDE API', mock: 'DEMO', manual: 'MANUAL', siwc: 'GPT SIWC' };

export class Registry {
  readonly providers = new Map<string, AIProvider>();
  private db: Db;
  constructor(db: Db, list: AIProvider[]) { this.db = db; for (const p of list) this.providers.set(p.id, p); }
  policy(): SelectionPolicy { return { ...DEFAULT_POLICY, ...this.db.getSetting<Partial<SelectionPolicy>>('selection', {}) }; }
  setPolicy(p: Partial<SelectionPolicy>): void { this.db.setSetting('selection', { ...this.policy(), ...p }); this.db.securityLog('selection_changed', 'admin', JSON.stringify(p).slice(0, 200)); }
  async refreshAll(): Promise<void> { await Promise.all([...this.providers.values()].map(p => p.refresh().catch(() => undefined))); }
  infos(): ProviderInfo[] { return [...this.providers.values()].map(p => p.info()); }
  get(id: string): AIProvider | undefined { return this.providers.get(id); }

  /** Providers the device may choose from (ready + visible), for GET /device/config. */
  deviceChoices(): { id: string; label: string; images: boolean }[] {
    const pol = this.policy();
    const out = [{ id: 'auto', label: 'AUTOMATICO', images: true }];
    for (const id of pol.deviceVisible) {
      const p = this.providers.get(id);
      if (p && p.info().status === 'ready') out.push({ id, label: SHORT[id] ?? id.toUpperCase(), images: p.info().capabilities.supportsImages });
    }
    return out;
  }

  select(requested: string, needImages: boolean): { provider?: AIProvider; error?: string } {
    const ok = (p: AIProvider | undefined) => !!p && p.info().status === 'ready' && (!needImages || p.info().capabilities.supportsImages);
    if (requested && requested !== 'auto') {
      const p = this.providers.get(requested);
      if (!p) return { error: 'provedor desconhecido' };
      if (p.info().status !== 'ready') return { error: `${p.name}: ${p.info().statusDetail || 'indisponivel'}` };
      if (needImages && !p.info().capabilities.supportsImages) return { error: `${p.name} nao suporta imagens` };
      return { provider: p };
    }
    const pol = this.policy();
    const pref = this.providers.get(pol.preferred);
    if (ok(pref)) return { provider: pref };
    for (const id of pol.autoOrder) { const p = this.providers.get(id); if (ok(p)) return { provider: p }; }
    return { error: needImages ? 'nenhum provedor com suporte a imagem disponivel' : 'nenhum provedor disponivel' };
  }

  /** Next provider for an explicit, owner-authorised failover (never by default). */
  failover(after: string, needImages: boolean): AIProvider | undefined {
    const pol = this.policy();
    if (!pol.allowFailover) return undefined;
    const order = pol.autoOrder.filter(id => id !== after);
    for (const id of order) { const p = this.providers.get(id); if (p && p.info().status === 'ready' && (!needImages || p.info().capabilities.supportsImages)) return p; }
    return undefined;
  }
}
