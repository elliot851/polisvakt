// Provperiod och prenumeration.
//
// 5 dagar gratis, sedan 29 kr/mån.
//
// Var ärlig med vad det här är: en spärr i klienten går att kringgå av den
// som verkligen vill. Den håller ordning på hederligt folk, inget mer. Riktig
// koll kräver att servern (Supabase) äger sanningen — därför synkas både
// provperiodens start och prenumerationsstatus mot backend när den är
// konfigurerad. Utan backend är allt lokalt och lätt att nollställa.
//
// Två viktiga produktbeslut ligger inbakade här:
//   1. Betalväggen visas aldrig mitt under körning. En bilist ska inte få en
//      modal i ansiktet i 90 km/h. Den väntar tills bilen står still.
//   2. Provperioden startar först när appen används på riktigt, inte vid
//      första sidladdningen.

import { deviceId } from './store.js';
import { apiHeaders } from './config.js';

const KEY = 'pv.billing.v1';
export const PRICE_TEXT = '99 kr/mån';
export const TRIAL_DAYS = 5;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} }

export class Billing extends EventTarget {
  /** @param {{url?:string, key?:string, paymentLink?:string}} cfg */
  constructor(cfg = {}) {
    super();
    this.cfg = cfg;
    this.state = {
      trialStart: null,
      status: 'unknown',      // unknown | trial | active | expired
      paidUntil: null,
      code: null,
      ...load(),
    };
    this.deferredPaywall = false;
  }

  configure(cfg) { this.cfg = { ...this.cfg, ...cfg }; }

  get trialEndsAt() {
    return this.state.trialStart ? this.state.trialStart + TRIAL_DAYS * 86400_000 : null;
  }

  get daysLeft() {
    if (!this.trialEndsAt) return TRIAL_DAYS;
    return Math.max(0, Math.ceil((this.trialEndsAt - Date.now()) / 86400_000));
  }

  get hoursLeft() {
    if (!this.trialEndsAt) return TRIAL_DAYS * 24;
    return Math.max(0, Math.ceil((this.trialEndsAt - Date.now()) / 3600_000));
  }

  /** Får appen användas just nu? */
  get allowed() {
    return this.status === 'trial' || this.status === 'active';
  }

  get status() {
    if (this.state.paidUntil && this.state.paidUntil > Date.now()) return 'active';
    if (!this.state.trialStart) return 'trial';           // ännu inte startad
    if (Date.now() < this.trialEndsAt) return 'trial';
    return 'expired';
  }

  /** Kallas när användaren faktiskt börjar köra appen. */
  beginTrial() {
    if (this.state.trialStart) return;
    this.state.trialStart = Date.now();
    this.#save();
    this.#syncUp();
    this.#emit('change');
  }

  /* ---- Backend ---- */

  get hasBackend() { return !!(this.cfg.url && this.cfg.key); }

  /**
   * Hämtar sanningen från servern. Serverns trialStart vinner alltid över
   * den lokala — annars räcker det att rensa webbläsardata för nytt prov.
   */
  async sync() {
    if (!this.hasBackend) { this.#emit('change'); return; }
    try {
      // Går via funktion istället för direktläsning: prenumeranttabellen
      // innehåller e-post och betalningsuppgifter som ingen klient ska kunna
      // hämta. Funktionen lämnar bara ut de två datumen.
      const r = await fetch(`${this.cfg.url}/rest/v1/rpc/get_subscription`, {
        method: 'POST',
        headers: { ...this.#headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_device: deviceId() }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const rows = await r.json();
      if (rows.length) {
        const row = rows[0];
        const remoteStart = row.trial_start ? Date.parse(row.trial_start) || +row.trial_start : null;
        if (remoteStart && (!this.state.trialStart || remoteStart < this.state.trialStart)) {
          this.state.trialStart = remoteStart;
        }
        this.state.paidUntil = row.paid_until ? (Date.parse(row.paid_until) || +row.paid_until) : null;
        this.#save();
      } else {
        await this.#syncUp();
      }
    } catch { /* offline — kör vidare på lokal status */ }
    this.#emit('change');
  }

  async #syncUp() {
    if (!this.hasBackend || !this.state.trialStart) return;
    try {
      await fetch(`${this.cfg.url}/rest/v1/subscribers`, {
        method: 'POST',
        headers: {
          ...this.#headers(),
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          device_id: deviceId(),
          trial_start: new Date(this.state.trialStart).toISOString(),
        }),
      });
    } catch {}
  }

  /**
   * Lös in en kod. Tänkt för manuell försäljning (Swish) innan Stripe är
   * på plats: koden slås upp i tabellen access_codes och binds till enheten.
   */
  async redeem(code) {
    const clean = String(code || '').trim().toUpperCase();
    if (!clean) return { ok: false, error: 'Ange en kod.' };
    if (!this.hasBackend) return { ok: false, error: 'Ingen backend konfigurerad.' };
    try {
      const r = await fetch(`${this.cfg.url}/rest/v1/rpc/redeem_code`, {
        method: 'POST',
        headers: { ...this.#headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_code: clean, p_device: deviceId() }),
      });
      if (!r.ok) return { ok: false, error: 'Koden gick inte att lösa in.' };
      const paidUntil = await r.json();
      if (!paidUntil) return { ok: false, error: 'Ogiltig eller redan använd kod.' };
      this.state.paidUntil = Date.parse(paidUntil) || +paidUntil;
      this.state.code = clean;
      this.#save();
      this.#emit('change');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'Nätverksfel.' };
    }
  }

  /** Öppnar Stripe-betallänken med enhetens id så webhooken hittar rätt rad. */
  checkoutUrl() {
    if (!this.cfg.paymentLink) return null;
    const u = new URL(this.cfg.paymentLink);
    u.searchParams.set('client_reference_id', deviceId());
    return u.toString();
  }

  #headers() {
    return apiHeaders();
  }

  #save() { save(this.state); }
  #emit(n) { this.dispatchEvent(new CustomEvent(n)); }

  /** Endast för utveckling. */
  resetTrial() {
    this.state = { trialStart: null, status: 'unknown', paidUntil: null, code: null };
    this.#save();
    this.#emit('change');
  }
}
