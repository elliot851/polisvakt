// Konton: e-post och lösenord via Supabase Auth.
//
// Byggt direkt mot REST-API:et istället för supabase-js, av samma skäl som
// resten av appen: inget byggsteg, inget CDN, ingenting som kan sluta svara
// mitt under en körning.
//
// Varför konton alls, när appen fungerar utan? Tre saker som inte går att
// lösa med ett slumpat enhets-id:
//   - Prenumerationen följer personen, inte telefonen. Byter du mobil eller
//     kör i två bilar ska du inte betala två gånger.
//   - Rapportpoängen blir meningsfull. Ett enhets-id går att nollställa genom
//     att rensa webbläsaren; ett konto gör det inte.
//   - Missbruk går att stoppa. Den som spammar falska polisrapporter kan
//     stängas av.
//
// Gästläge finns kvar med flit. Att tvinga fram registrering innan någon ens
// sett kartan är ett säkert sätt att tappa användare, och appen fungerar
// utmärkt lokalt utan konto.

import { CONFIG, hasBackend } from './config.js';

const SESSION_KEY = 'pv.session.v1';
const GUEST_KEY = 'pv.guest.v1';
const THROTTLE_KEY = 'pv.auththrottle.v1';

/**
 * Spärr efter upprepade felaktiga lösenord.
 *
 * Var ärlig med vad det här är: en spärr i klienten stoppar någon som sitter
 * och gissar i appen, men inte den som skickar anrop direkt mot API:et. Det
 * riktiga skyddet ligger hos Supabase, som har egna gränser per IP.
 *
 * Den här finns för det vanliga fallet — någon som skrivit fel och börjar
 * hamra — och för att ge ett begripligt besked istället för att bara säga
 * "fel lösenord" en sjunde gång.
 *
 * Väntetiden växer: 1, 2, 5, 15 minuter. Den som verkligen glömt sitt
 * lösenord ska knuffas mot återställningen, inte mot fler gissningar.
 */
const MAX_ATTEMPTS = 5;
const LOCKOUT_STEPS = [60, 120, 300, 900];   // sekunder

const throttle = {
  read() {
    try { return JSON.parse(localStorage.getItem(THROTTLE_KEY)) || {}; } catch { return {}; }
  },
  write(v) { try { localStorage.setItem(THROTTLE_KEY, JSON.stringify(v)); } catch {} },

  /** Hur många sekunder till nästa försök får göras? 0 = fritt fram. */
  lockedFor(email) {
    const s = this.read()[key(email)];
    if (!s?.until) return 0;
    return Math.max(0, Math.ceil((s.until - Date.now()) / 1000));
  },

  attemptsLeft(email) {
    const s = this.read()[key(email)];
    return Math.max(0, MAX_ATTEMPTS - (s?.fails || 0));
  },

  fail(email) {
    const all = this.read();
    const k = key(email);
    const s = all[k] || { fails: 0, lockouts: 0 };
    s.fails++;
    if (s.fails >= MAX_ATTEMPTS) {
      const step = LOCKOUT_STEPS[Math.min(s.lockouts, LOCKOUT_STEPS.length - 1)];
      s.until = Date.now() + step * 1000;
      s.lockouts++;
      s.fails = 0;
    }
    all[k] = s;
    this.write(all);
    return s;
  },

  clear(email) {
    const all = this.read();
    delete all[key(email)];
    this.write(all);
  },
};

const key = email => (email || '').trim().toLowerCase();

/** "2 minuter" / "45 sekunder" — begriplig väntetid. */
function humanWait(seconds) {
  if (seconds >= 90) return `${Math.ceil(seconds / 60)} minuter`;
  if (seconds >= 60) return 'en minut';
  return `${seconds} sekunder`;
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
}
function saveSession(s) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {}
}

/** Översätt Supabases engelska felmeddelanden till något en förare förstår. */
function humanError(status, body) {
  const msg = (body?.msg || body?.error_description || body?.message || body?.error || '').toLowerCase();

  if (msg.includes('invalid login credentials')) return 'Fel e-post eller lösenord.';
  if (msg.includes('email not confirmed')) return 'Bekräfta din e-post först. Kolla inkorgen, och skräpposten.';
  if (msg.includes('user already registered') || msg.includes('already been registered'))
    return 'Det finns redan ett konto med den e-posten. Logga in istället.';
  if (msg.includes('password should be at least')) return 'Lösenordet måste vara minst 8 tecken.';
  if (msg.includes('unable to validate email') || msg.includes('invalid format'))
    return 'E-postadressen ser inte giltig ut.';
  if (msg.includes('rate limit') || status === 429)
    return 'För många försök. Vänta en stund och prova igen.';
  if (msg.includes('signups not allowed')) return 'Registrering är avstängd just nu.';
  if (status === 0) return 'Ingen internetanslutning.';
  return body?.msg || body?.error_description || 'Något gick fel. Försök igen.';
}

export class Auth extends EventTarget {
  constructor() {
    super();
    this.session = loadSession();
    this.user = this.session?.user || null;
    this.refreshTimer = null;
    if (this.session) this.#scheduleRefresh();
  }

  get available() { return hasBackend(); }
  get signedIn() { return !!(this.session?.access_token && this.user); }
  get isGuest() { return localStorage.getItem(GUEST_KEY) === '1'; }
  get email() { return this.user?.email || null; }

  /** Stabil identitet för rapporter och poäng: kontot om det finns, annars enheten. */
  get identity() {
    return this.user?.id || null;
  }

  continueAsGuest() {
    localStorage.setItem(GUEST_KEY, '1');
    this.#emit('change');
  }

  clearGuest() {
    localStorage.removeItem(GUEST_KEY);
    this.#emit('change');
  }

  /** Har föraren tagit ställning — konto eller gäst? */
  get decided() { return this.signedIn || this.isGuest; }

  /* ---- Anrop ---- */

  async #call(path, { method = 'POST', body, auth = false } = {}) {
    if (!this.available) return { ok: false, error: 'Ingen backend konfigurerad.' };
    const headers = {
      apikey: CONFIG.supabaseAnonKey,
      'Content-Type': 'application/json',
    };
    if (auth && this.session?.access_token) {
      headers.Authorization = `Bearer ${this.session.access_token}`;
    }
    try {
      const res = await fetch(`${CONFIG.supabaseUrl}/auth/v1${path}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) return { ok: false, error: humanError(res.status, data), status: res.status };
      return { ok: true, data };
    } catch {
      return { ok: false, error: 'Ingen kontakt med servern. Kolla nätet.' };
    }
  }

  #store(data) {
    if (!data?.access_token) return;
    this.session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
      user: data.user,
    };
    this.user = data.user;
    saveSession(this.session);
    this.clearGuestSilent();
    this.#scheduleRefresh();
    this.#emit('change');
  }

  clearGuestSilent() { localStorage.removeItem(GUEST_KEY); }

  /* ---- Publika åtgärder ---- */

  async signUp(email, password, username) {
    const check = validate(email, password);
    if (check) return { ok: false, error: check };

    const uname = (username || '').trim().toLowerCase();
    if (uname) {
      const bad = validateUsername(uname);
      if (bad) return { ok: false, error: bad };
      if (!(await this.usernameAvailable(uname))) {
        return { ok: false, error: `Användarnamnet "${uname}" är upptaget. Välj ett annat.` };
      }
    }

    const res = await this.#call('/signup', {
      body: {
        email: email.trim().toLowerCase(),
        password,
        data: uname ? { nickname: uname.slice(0, 20) } : undefined,
      },
    });
    if (!res.ok) return res;

    // Med e-postbekräftelse påslagen får vi ingen token förrän länken klickats
    if (res.data.access_token) {
      this.#store(res.data);
      if (uname) await this.claimUsername(uname);
      return { ok: true, confirmed: true, username: uname };
    }
    return { ok: true, confirmed: false, username: uname };
  }

  /** Är namnet ledigt? Svarar bara ja eller nej, aldrig vem som har det. */
  async usernameAvailable(username) {
    if (!hasBackend()) return true;
    try {
      const r = await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/username_available`, {
        method: 'POST',
        headers: { apikey: CONFIG.supabaseAnonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_username: username.trim().toLowerCase() }),
      });
      if (!r.ok) return true;      // kan vi inte kolla, blockera inte registreringen
      return (await r.json()) === true;
    } catch { return true; }
  }

  /** Knyt namnet till kontot. Kräver att man är inloggad. */
  async claimUsername(username) {
    if (!this.session?.access_token) return { ok: false, error: 'Inte inloggad.' };
    try {
      const r = await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/claim_username`, {
        method: 'POST',
        headers: {
          apikey: CONFIG.supabaseAnonKey,
          Authorization: `Bearer ${this.session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_username: username.trim().toLowerCase() }),
      });
      if (!r.ok) return { ok: false, error: 'Kunde inte spara användarnamnet.' };
      const code = await r.json();
      return {
        ok: code === 'ok',
        error: {
          upptaget: 'Användarnamnet är upptaget.',
          ogiltigt: 'Användarnamnet måste vara 3–20 tecken: bokstäver, siffror, punkt eller streck.',
          inte_inloggad: 'Du måste vara inloggad.',
        }[code],
      };
    } catch { return { ok: false, error: 'Nätverksfel.' }; }
  }

  /**
   * Logga in med e-post ELLER användarnamn.
   *
   * Fältet är ett enda. Innehåller texten ett @ behandlas den som e-post,
   * annars som användarnamn — ingen behöver välja i en meny vad de just skrev.
   *
   * Användarnamnet växlas till e-post av en funktion på servern som först
   * verifierar lösenordet. Fel lösenord och okänt namn ger samma svar, så
   * namnen går inte att kartlägga utifrån.
   */
  async #resolveEmail(identifier, password) {
    const id = (identifier || '').trim();
    if (id.includes('@')) return id.toLowerCase();
    if (!hasBackend()) return null;

    try {
      const r = await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/email_for_login`, {
        method: 'POST',
        headers: { apikey: CONFIG.supabaseAnonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_username: id.toLowerCase(), p_password: password }),
      });
      if (!r.ok) return null;
      const email = await r.json();
      return typeof email === 'string' && email ? email : null;
    } catch { return null; }
  }

  async signIn(identifier, password) {
    if (!identifier || !password) {
      return { ok: false, error: 'Fyll i användarnamn eller e-post, och lösenord.' };
    }

    // Spärren räknar på det man skrev, så byte mellan namn och e-post inte
    // ger fem nya försök var.
    const email = await this.#resolveEmail(identifier, password);
    if (!email) {
      // Antingen fel lösenord eller okänt namn — servern skiljer dem inte åt,
      // och det ska vi inte heller göra.
      const isUsername = !String(identifier).includes('@');
      if (isUsername) {
        const wait0 = throttle.lockedFor(identifier);
        if (wait0 > 0) {
          return { ok: false, locked: true, waitSeconds: wait0,
            error: `För många försök. Vänta ${humanWait(wait0)} och prova igen.` };
        }
        const s = throttle.fail(identifier);
        if (s.until) {
          const secs = Math.ceil((s.until - Date.now()) / 1000);
          return { ok: false, locked: true, waitSeconds: secs,
            error: `För många felaktiga försök. Vänta ${humanWait(secs)} och prova igen, eller återställ lösenordet.` };
        }
        const left = throttle.attemptsLeft(identifier);
        return { ok: false, attemptsLeft: left,
          error: left <= 2
            ? `Fel användarnamn eller lösenord. ${left} försök kvar innan kontot spärras en stund.`
            : 'Fel användarnamn eller lösenord.' };
      }
    }

    return this.#signInWithEmail(email || identifier, password, identifier);
  }

  async #signInWithEmail(email, password, throttleKey = null) {
    const bucket = throttleKey || email;
    const wait = throttle.lockedFor(bucket);
    if (wait > 0) {
      return {
        ok: false, locked: true, waitSeconds: wait,
        error: `För många försök. Vänta ${humanWait(wait)} och prova igen, eller använd "Glömt lösenordet?".`,
      };
    }

    const res = await this.#call('/token?grant_type=password', {
      body: { email: email.trim().toLowerCase(), password },
    });

    if (!res.ok) {
      // Bara felaktiga uppgifter räknas. Nätverksfel ska inte låsa ute någon.
      if (res.status === 400 || res.status === 401) {
        const s = throttle.fail(bucket);
        if (s.until) {
          const secs = Math.ceil((s.until - Date.now()) / 1000);
          return {
            ok: false, locked: true, waitSeconds: secs,
            error: `För många felaktiga försök. Vänta ${humanWait(secs)} och prova igen, eller återställ lösenordet.`,
          };
        }
        const left = throttle.attemptsLeft(bucket);
        return {
          ...res,
          attemptsLeft: left,
          error: left <= 2
            ? `${res.error} ${left} försök kvar innan kontot spärras en stund.`
            : res.error,
        };
      }
      return res;
    }

    throttle.clear(bucket);
    throttle.clear(email);
    this.#store(res.data);
    return { ok: true };
  }

  /** Hur många försök har den här adressen kvar? För gränssnittet. */
  attemptsLeft(email) { return throttle.attemptsLeft(email); }
  lockedFor(email) { return throttle.lockedFor(email); }

  /**
   * Skicka återställningslänk.
   *
   * redirect_to måste peka på appen och finnas i Supabases lista över
   * tillåtna adresser, annars skickar länken användaren till standardadressen
   * — vilket var precis vad som hände när Site URL fortfarande stod på
   * localhost:3000 och länken ledde till en död sida.
   */
  async sendPasswordReset(email) {
    if (!email) return { ok: false, error: 'Skriv din e-postadress först.' };
    const redirect = location.origin + location.pathname;
    const res = await this.#call(
      `/recover?redirect_to=${encodeURIComponent(redirect)}`,
      { body: { email: email.trim().toLowerCase() } }
    );
    if (!res.ok) return res;
    return { ok: true };
  }

  /* ---- Återställning ---- */

  /**
   * Kom vi hit från en återställningslänk?
   *
   * Supabase lägger token i adressens fragment: #access_token=…&type=recovery.
   * Fragmentet skickas aldrig till servern, så det här måste läsas i klienten.
   * Vi plockar bort det ur adressfältet direkt efteråt så att en token inte
   * blir kvar i historiken.
   */
  consumeRecoveryLink() {
    const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    if (!hash) return null;
    const p = new URLSearchParams(hash);

    const errorCode = p.get('error_code') || p.get('error');
    if (errorCode) {
      history.replaceState(null, '', location.pathname + location.search);
      const desc = (p.get('error_description') || '').toLowerCase();
      return {
        error: desc.includes('expired') || errorCode === 'otp_expired'
          ? 'Länken har gått ut. Begär en ny återställning.'
          : 'Länken gick inte att använda. Begär en ny återställning.',
      };
    }

    if (p.get('type') !== 'recovery') return null;
    const access_token = p.get('access_token');
    const refresh_token = p.get('refresh_token');
    if (!access_token) return null;

    history.replaceState(null, '', location.pathname + location.search);

    // Tokenen ger rätt att byta lösenord. Spara som session så anropet nedan
    // kan använda den.
    this.session = {
      access_token, refresh_token,
      expires_at: Date.now() + (parseInt(p.get('expires_in'), 10) || 3600) * 1000,
      user: null,
    };
    return { ready: true };
  }

  /** Sätt nytt lösenord med tokenen från återställningslänken. */
  async setNewPassword(password) {
    if (!password || password.length < 8) {
      return { ok: false, error: 'Lösenordet måste vara minst 8 tecken.' };
    }
    if (/^\d+$/.test(password)) {
      return { ok: false, error: 'Välj ett lösenord med både bokstäver och siffror.' };
    }
    if (!this.session?.access_token) {
      return { ok: false, error: 'Återställningslänken saknas eller har gått ut.' };
    }
    const res = await this.#call('/user', { method: 'PUT', body: { password }, auth: true });
    if (!res.ok) return res;

    // Servern svarar med användaren; nu är sessionen fullvärdig
    this.user = res.data;
    this.session.user = res.data;
    saveSession(this.session);
    throttle.clear(res.data?.email || '');
    this.#emit('change');
    return { ok: true, email: res.data?.email };
  }

  async signOut() {
    if (this.session?.access_token) await this.#call('/logout', { auth: true });
    this.session = null;
    this.user = null;
    saveSession(null);
    clearTimeout(this.refreshTimer);
    this.#emit('change');
  }

  /* ---- Sessionshantering ---- */

  #scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    if (!this.session?.refresh_token) return;
    // Förnya en minut innan den går ut, men aldrig oftare än var 30:e sekund
    const wait = Math.max(30000, this.session.expires_at - Date.now() - 60000);
    this.refreshTimer = setTimeout(() => this.refresh(), wait);
  }

  async refresh() {
    if (!this.session?.refresh_token) return false;
    const res = await this.#call('/token?grant_type=refresh_token', {
      body: { refresh_token: this.session.refresh_token },
    });
    if (!res.ok) {
      // Förnyelsen kan misslyckas för att nätet är nere — logga inte ut då
      if (res.status === 400 || res.status === 401) {
        this.session = null; this.user = null; saveSession(null); this.#emit('change');
      } else {
        this.refreshTimer = setTimeout(() => this.refresh(), 60000);
      }
      return false;
    }
    this.#store(res.data);
    return true;
  }

  /** Giltig token att skicka med mot databasen, eller null. */
  async accessToken() {
    if (!this.session) return null;
    if (Date.now() > this.session.expires_at - 30000) await this.refresh();
    return this.session?.access_token || null;
  }

  #emit(name) { this.dispatchEvent(new CustomEvent(name)); }
}

function validate(email, password) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
    return 'Skriv en giltig e-postadress.';
  }
  if (!password || password.length < 8) return 'Lösenordet måste vara minst 8 tecken.';
  if (/^\d+$/.test(password)) return 'Välj ett lösenord med både bokstäver och siffror.';
  return null;
}

/** Samma regler som funktionen på servern, så felet syns innan man trycker. */
function validateUsername(u) {
  const s = (u || '').trim().toLowerCase();
  if (!s) return null;                                  // valfritt
  if (s.includes('@')) return 'Användarnamnet får inte innehålla @.';
  if (s.length < 3) return 'Användarnamnet måste vara minst 3 tecken.';
  if (s.length > 20) return 'Användarnamnet får vara högst 20 tecken.';
  if (!/^[a-z0-9._-]+$/.test(s)) {
    return 'Bara bokstäver a–z, siffror, punkt, understreck och bindestreck.';
  }
  return null;
}

export { validate, validateUsername };
