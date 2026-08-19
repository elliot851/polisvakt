// Privata grupper: åkerier, trafikskolor och kompisgäng.
//
// Ett åkeri med femton bilar vill att förarna ser varandras rapporter utan att
// varenda varning går ut till hela Västmanland. En rapport får därför en
// frivillig grupp, och den som är inloggad ser unionen av det publika flödet
// och varje grupp hen är med i.
//
// Byggt mot REST-API:et med rå fetch, av samma skäl som resten av appen: inget
// byggsteg, inget CDN, ingenting som kan sluta svara mitt under en körning.
//
// TRE SAKER ATT FÖRSTÅ INNAN DU ÄNDRAR HÄR:
//
//   1. Modulen filtrerar ingenting. Det är lockande att tro att den här filen
//      ska sortera bort rapporter som inte hör till mina grupper, men den
//      filtreringen sitter i radsäkerhetsreglerna i supabase/grupper.sql och
//      ska sitta där. Servern lämnar bara ut det du får se, och js/store.js
//      hämtar som vanligt utan att veta att grupper finns. Skulle vi filtrera
//      även här hade vi byggt ett andra, sämre skydd som ser ut som det
//      riktiga — och den dagen någon läser flödet med curl istället för med
//      appen är klientfiltret inte värt någonting.
//
//   2. Ingenting här bestämmer vem som får göra vad. Varje statuskod modulen
//      översätter är ett svar från en databasfunktion som redan har kollat
//      ägarskap, utgångsdatum och användningstak. Kontrollerna som finns i
//      klienten är till för att slippa ett onödigt anrop, inte för att skydda.
//
//   3. Grupper kräver konto. Resten av appen klarar sig med ett slumpat
//      device_id, men ett enhets-id ligger i klartext i klienten och går att
//      hitta på. Kunde man äga en grupp med ett sådant kunde vem som helst
//      påstå sig vara ägaren och kasta ut åkeriets förare.
//
// Modulen rör aldrig DOM:en. Den håller en lista, skickar 'change' när den
// ändras, och låter js/app.js rita.

import { CONFIG, hasBackend, apiHeaders } from './config.js';

const CACHE_KEY = 'pv.groups.v1';

/**
 * Grupptyperna, i den ordning de ska stå i en meny.
 *
 * Värdena är avskalade från å, ä och ö med flit — de är enum-värden i ett
 * check-villkor i databasen, och en teckenkodning som glider någonstans på
 * vägen ska inte kunna göra att en grupp inte går att spara.
 */
export const KINDS = [
  { value: 'akeri',       label: 'Åkeri' },
  { value: 'trafikskola', label: 'Trafikskola' },
  { value: 'vanner',      label: 'Vänner' },
  { value: 'ovrigt',      label: 'Övrigt' },
];

export const kindLabel = v => KINDS.find(k => k.value === v)?.label || 'Övrigt';

/* ---- Koder -------------------------------------------------------- */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 10;

/**
 * Städa en kod som någon skrivit av från ett papper eller läst upp i telefon.
 *
 * Samma regler som public.clean_invite_code i supabase/grupper.sql, och det är
 * ingen slump att de står på två ställen: servern måste göra det för att inte
 * avvisa hederligt folk, klienten gör det för att kunna säga "koden är för
 * kort" innan anropet går iväg. Ändras den ena måste den andra ändras med.
 *
 * Alfabetet saknar I, L, O och U. De tre första för att de går att förväxla
 * med ettor och nollor, U för att slumpen inte ska stava något olämpligt. Det
 * någon skrivit som O, I eller L var alltså med säkerhet en nolla eller en
 * etta, och tolkas så istället för att ge ett felmeddelande.
 */
export function normalizeCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** "ABCDE-FGHIJ". Bara för visning — skicka aldrig den formaterade strängen. */
export function formatCode(code) {
  const c = normalizeCode(code);
  return c.length === CODE_LENGTH ? `${c.slice(0, 5)}-${c.slice(5)}` : c;
}

/** Ser koden ut att kunna vara giltig? Säger inget om att den finns. */
export function looksLikeCode(input) {
  const c = normalizeCode(input);
  return c.length === CODE_LENGTH && [...c].every(ch => ALPHABET.includes(ch));
}

/* ---- Validering --------------------------------------------------- */

/** Samma gränser som check-villkoret på groups.name, så felet syns direkt. */
export function validateGroupName(name) {
  const s = String(name ?? '').trim();
  if (s.length < 2) return 'Namnet måste vara minst 2 tecken.';
  if (s.length > 60) return 'Namnet får vara högst 60 tecken.';
  return null;
}

/* ---- Felöversättningar -------------------------------------------- */

/**
 * Statuskoderna från databasfunktionerna, på begriplig svenska.
 *
 * Funktionerna returnerar korta koder istället för att kasta undantag, precis
 * som claim_username i schema.sql. Skälet är att en förare aldrig ska behöva
 * läsa en Postgres-felsträng, och att texten ska gå att ändra utan att någon
 * rör databasen.
 */
const STATUS_TEXT = {
  inte_inloggad:        'Du måste vara inloggad för att använda grupper.',
  inte_agare:           'Bara den som äger gruppen kan göra det.',
  inte_medlem:          'Du är inte med i den gruppen.',
  agare:                'Ägaren går inte att ta bort. Lämna över ägarskapet först.',
  agare_kvar:           'Du äger gruppen och kan inte lämna den så länge andra är kvar. '
                        + 'Lämna över ägarskapet till någon annan, eller ta bort gruppen.',
  ogiltigt_namn:        'Namnet måste vara mellan 2 och 60 tecken.',
  for_manga_grupper:    'Du kan äga högst tio grupper.',
  for_manga_medlemskap: 'Du kan vara med i högst 25 grupper.',
  ogiltig:              'Koden stämmer inte. Kontrollera att du skrivit rätt.',
  utgangen:             'Koden har gått ut. Be den som bjöd in dig om en ny.',
  slut:                 'Koden är förbrukad. Be om en ny.',
  full:                 'Gruppen är full.',
};

/**
 * Okänd och återkallad kod ger samma svar från servern, med flit: att skilja
 * dem åt hade berättat för den som testar en gammal läckt kod att gruppen
 * finns kvar. Texten ovan är därför medvetet vag. Ändra den inte till
 * "koden finns inte".
 */

/** Vad servern sa, eller ett rimligt standardsvar. */
function statusError(status) {
  if (!status || status === 'ok' || status === 'ok_borttagen') return null;
  return STATUS_TEXT[status] || 'Något gick fel. Försök igen.';
}

/* ---- Cache -------------------------------------------------------- */

/**
 * Grupplistan sparas lokalt.
 *
 * Inte för att spara ett anrop, utan för att appen ska kunna säga "du
 * rapporterar till Åkeriet" direkt när den startar i en bil utan täckning.
 * Listan är bara namn och roll — inga koder, inga medlemmar, ingenting som
 * gör skada om telefonen tappas bort.
 */
function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || []; } catch { return []; }
}
function writeCache(v) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(v || [])); } catch {}
}

/* ---- Modulen ------------------------------------------------------ */

export class Groups extends EventTarget {
  constructor() {
    super();
    this.groups = readCache();
    this.loading = false;
    this.error = null;
    this.lastSync = null;
  }

  get available() { return hasBackend(); }

  /** Grupp-id:n, för den som vill lägga en rapport i en av dem. */
  get ids() { return this.groups.map(g => g.id); }

  get(id) { return this.groups.find(g => g.id === id) || null; }
  isOwner(id) { return this.get(id)?.roll === 'owner'; }
  get owned() { return this.groups.filter(g => g.roll === 'owner'); }

  /* ---- Anrop ---- */

  /**
   * Ett anrop mot en databasfunktion.
   *
   * @param {string} fn        funktionens namn
   * @param {object} body      namngivna argument
   * @param {boolean} retry    får anropet göras om vid nätverksfel?
   *
   * Om retry: bara läsningar. Att göra om ett join_group som kanske gick
   * igenom är visserligen ofarligt — funktionen svarar "ok, redan medlem" utan
   * att bränna en användning — men samma resonemang håller inte för
   * rotate_group_invite, där ett omtag som råkar lyckas två gånger ger ägaren
   * en kod hen redan hunnit skicka ut i fel version. Skrivningar körs en gång
   * och får ett ärligt felmeddelande istället.
   */
  async #call(fn, body = {}, { retry = false } = {}) {
    if (!this.available) return { ok: false, error: 'Ingen backend konfigurerad.' };

    const url = `${CONFIG.supabaseUrl}/rest/v1/rpc/${fn}`;
    const init = {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };

    const attempts = retry ? 3 : 1;
    let lastError = 'Ingen kontakt med servern. Kolla nätet.';

    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url, init);
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }

        if (res.ok) return { ok: true, data };

        // 404 med PGRST202 betyder att funktionen inte finns — SQL:en är inte
        // körd. 403 betyder att den finns men inte för den här rollen, vilket
        // i praktiken alltid är samma sak som "du är utloggad", eftersom anon
        // inte har EXECUTE på någon av gruppfunktionerna.
        if (res.status === 404) {
          return { ok: false, error: 'Grupper är inte påslagna i den här installationen än.' };
        }
        if (res.status === 401 || res.status === 403) {
          return { ok: false, error: STATUS_TEXT.inte_inloggad };
        }
        if (res.status >= 500 && i < attempts - 1) {
          lastError = 'Servern svarar inte. Försök igen.';
          await pause(400 * (i + 1));
          continue;
        }
        return { ok: false, error: serverError(data), status: res.status };
      } catch {
        // fetch kastar bara vid nätverksfel, aldrig vid HTTP-fel
        if (i < attempts - 1) { await pause(400 * (i + 1)); continue; }
      }
    }
    return { ok: false, error: lastError };
  }

  /** Anrop som svarar med en enkel statussträng: "ok", "inte_agare", … */
  async #status(fn, body = {}) {
    const res = await this.#call(fn, body);
    if (!res.ok) return res;
    const status = typeof res.data === 'string' ? res.data : res.data?.status;
    const error = statusError(status);
    return error ? { ok: false, error, status } : { ok: true, status };
  }

  /* ---- Läsning ---- */

  /**
   * Hämta mina grupper.
   *
   * Servern lämnar bara ut de grupper man faktiskt är med i, så listan är
   * densamma som "vad får jag se". Inga ägar-id och inga koder följer med —
   * koden hämtar ägaren separat med invite().
   */
  async refresh() {
    if (!this.available) return { ok: false, error: 'Ingen backend konfigurerad.' };
    this.loading = true;
    this.#emit('status');

    const res = await this.#call('my_groups', {}, { retry: true });

    this.loading = false;
    if (!res.ok) {
      this.error = res.error;
      this.#emit('status');
      return res;                   // den cachade listan får ligga kvar
    }

    this.error = null;
    this.lastSync = Date.now();
    this.groups = Array.isArray(res.data) ? res.data : [];
    writeCache(this.groups);
    this.#emit('change');
    return { ok: true, groups: this.groups };
  }

  /**
   * Medlemmarna i en grupp.
   *
   * Raderna har ett handtag, inte ett konto-id. Handtaget är slumpat och
   * betyder ingenting någon annanstans i systemet, och det är hela poängen:
   * konto-id är för inloggade exakt samma sträng som device_id i
   * rapportflödet, och den som har den kan koppla rapporter till person.
   * Handtaget duger utmärkt för "ta bort den där raden".
   */
  async members(groupId) {
    if (!groupId) return { ok: false, error: 'Ingen grupp vald.' };
    const res = await this.#call('group_members_list', { p_group: groupId }, { retry: true });
    if (!res.ok) return res;
    return { ok: true, members: Array.isArray(res.data) ? res.data : [] };
  }

  /**
   * Gruppens aktuella inbjudningskod. Bara ägaren får ut den.
   *
   * Tomt svar betyder två helt olika saker som klienten inte kan skilja åt:
   * antingen äger du inte gruppen, eller så har koden gått ut. Det är med
   * flit — servern svarar likadant i båda fallen så att en medlem inte kan
   * lista ut vem som är ägare genom att prova. Föreslå att rotera; det är
   * rätt åtgärd i det ena fallet och nekas i det andra.
   */
  async invite(groupId) {
    if (!groupId) return { ok: false, error: 'Ingen grupp vald.' };
    const res = await this.#call('group_invite', { p_group: groupId }, { retry: true });
    if (!res.ok) return res;
    const row = Array.isArray(res.data) ? res.data[0] : res.data;
    if (!row) return { ok: true, invite: null };
    return {
      ok: true,
      invite: {
        kod: row.kod,
        visning: formatCode(row.kod),
        giltigTill: row.giltig_till ? Date.parse(row.giltig_till) : null,
        anvant: row.anvant ?? 0,
        kvar: Math.max(0, (row.max_anvandningar ?? 0) - (row.anvant ?? 0)),
        maxAnvandningar: row.max_anvandningar ?? 0,
      },
    };
  }

  /* ---- Skrivning ---- */

  /** Skapa en grupp. Den som skapar blir ägare och får en färdig kod. */
  async create(name, kind = 'ovrigt', nickname = null) {
    const bad = validateGroupName(name);
    if (bad) return { ok: false, error: bad };

    const res = await this.#call('create_group', {
      p_name: String(name).trim(),
      p_kind: KINDS.some(k => k.value === kind) ? kind : 'ovrigt',
      p_nickname: nickname || null,
    });
    if (!res.ok) return res;

    const error = statusError(res.data?.status);
    if (error) return { ok: false, error, status: res.data?.status };

    await this.refresh();
    return {
      ok: true,
      group: res.data.grupp,
      code: res.data.kod,
      display: formatCode(res.data.kod),
    };
  }

  /**
   * Gå med med en kod.
   *
   * Kontrollen av längd här sparar ett anrop och en miss mot spärren för den
   * som råkat klistra in halva koden. Allt annat — utgångsdatum, tak,
   * medlemsgräns, spärren mot kodgissning — avgörs på servern.
   */
  async join(code, nickname = null) {
    const clean = normalizeCode(code);
    if (!clean) return { ok: false, error: 'Skriv in koden du fått.' };
    if (clean.length !== CODE_LENGTH) {
      return { ok: false, error: `Koden är ${CODE_LENGTH} tecken. Du skrev ${clean.length}.` };
    }

    const res = await this.#call('join_group', { p_code: clean, p_nickname: nickname || null });
    if (!res.ok) return res;

    const status = res.data?.status;

    // Spärren efter tio missar på en timme. Servern säger hur länge.
    if (status === 'for_manga_forsok') {
      const s = res.data?.vanta_sekunder || 0;
      return {
        ok: false, locked: true, waitSeconds: s,
        error: `För många försök med fel kod. Vänta ${humanWait(s)} och prova igen.`,
      };
    }

    const error = statusError(status);
    if (error) return { ok: false, error, status };

    await this.refresh();
    return { ok: true, group: res.data.grupp, alreadyMember: !!res.data.redan_medlem };
  }

  /**
   * Lämna en grupp.
   *
   * Rapporterna man lagt i gruppen stannar kvar — de tillhör gruppen, inte
   * personen. Läsrätten försvinner däremot direkt. Se docs/GRUPPER.md.
   *
   * Ägaren kan bara gå om hen är ensam kvar, och då tas gruppen bort. Svaret
   * skiljer på de två utfallen så gränssnittet kan säga rätt sak.
   */
  async leave(groupId) {
    if (!groupId) return { ok: false, error: 'Ingen grupp vald.' };
    const res = await this.#status('leave_group', { p_group: groupId });
    if (!res.ok) return res;
    await this.refresh();
    return { ok: true, deleted: res.status === 'ok_borttagen' };
  }

  /**
   * Byt inbjudningskod.
   *
   * Återställningen efter en läcka: alla gamla koder återkallas i samma svep.
   * Redan invandrade medlemmar sitter kvar — koden är dörren, inte
   * medlemskapet — så gå igenom medlemslistan efteråt.
   */
  async rotateInvite(groupId, { days = 14, maxUses = 25 } = {}) {
    if (!groupId) return { ok: false, error: 'Ingen grupp vald.' };
    const res = await this.#call('rotate_group_invite', {
      p_group: groupId,
      p_days: clamp(days, 1, 365),
      p_max_uses: clamp(maxUses, 1, 500),
    });
    if (!res.ok) return res;

    const error = statusError(res.data?.status);
    if (error) return { ok: false, error, status: res.data?.status };

    return {
      ok: true,
      code: res.data.kod,
      display: formatCode(res.data.kod),
      validUntil: res.data.giltig_till ? Date.parse(res.data.giltig_till) : null,
      maxUses: res.data.max_anvandningar ?? maxUses,
    };
  }

  /** Byt namn på gruppen. Bara ägaren. */
  async rename(groupId, name) {
    const bad = validateGroupName(name);
    if (bad) return { ok: false, error: bad };
    const res = await this.#status('rename_group', {
      p_group: groupId, p_name: String(name).trim(),
    });
    if (!res.ok) return res;
    await this.refresh();
    return { ok: true };
  }

  /** Kasta ut en medlem. Pekas ut med handtaget ur members(). */
  async removeMember(handle) {
    if (!handle) return { ok: false, error: 'Ingen medlem vald.' };
    return this.#status('remove_group_member', { p_handle: handle });
  }

  /**
   * Lämna över ägarskapet.
   *
   * Vägen ut för en ägare som vill lämna en grupp som lever vidare. Utan den
   * hade regeln "ägaren får inte lämna medan andra är kvar" låst in ägaren
   * för alltid.
   */
  async transferOwnership(handle) {
    if (!handle) return { ok: false, error: 'Ingen medlem vald.' };
    const res = await this.#status('transfer_group_ownership', { p_handle: handle });
    if (!res.ok) return res;
    await this.refresh();
    return { ok: true };
  }

  /**
   * Ta bort gruppen helt. Bara ägaren.
   *
   * Kaskaden tar medlemskap, koder OCH gruppens rapporter. Det är med flit:
   * rapporterna ska försvinna, inte plötsligt bli publika. Fråga en gång till
   * i gränssnittet innan du anropar den här.
   */
  async remove(groupId) {
    if (!groupId) return { ok: false, error: 'Ingen grupp vald.' };
    const res = await this.#status('delete_group', { p_group: groupId });
    if (!res.ok) return res;
    await this.refresh();
    return { ok: true };
  }

  /** Töm det lokala minnet. Anropas vid utloggning. */
  clear() {
    this.groups = [];
    this.error = null;
    this.lastSync = null;
    writeCache([]);
    this.#emit('change');
  }

  #emit(name) { this.dispatchEvent(new CustomEvent(name)); }
}

/* ---- Småsaker ----------------------------------------------------- */

const pause = ms => new Promise(r => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || lo)));

/** "2 minuter" / "45 sekunder" — samma ton som spärren i js/auth.js. */
function humanWait(seconds) {
  if (seconds >= 90) return `${Math.ceil(seconds / 60)} minuter`;
  if (seconds >= 60) return 'en minut';
  return `${Math.max(1, Math.round(seconds))} sekunder`;
}

/**
 * PostgREST-fel som text.
 *
 * Databasfunktionerna svarar med statuskoder istället för undantag, så hit
 * kommer man bara när något oväntat hänt — ett brutet check-villkor eller en
 * utlösare som sagt ifrån. Meddelandet från servern är på engelska och kan
 * innehålla kolumnnamn, så det visas inte för föraren.
 */
function serverError(data) {
  const msg = (data?.message || data?.hint || '').toLowerCase();
  if (msg.includes('grupp du inte är med i') || msg.includes('grupp du inte')) {
    return 'Den rapporten tillhör en grupp du inte är med i.';
  }
  if (msg.includes('unik inbjudningskod')) {
    return 'Kunde inte skapa en kod just nu. Försök igen.';
  }
  return 'Något gick fel. Försök igen.';
}
