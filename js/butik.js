/* =====================================================================
   Butiken — den femte fliken.

   Hela hyllan bor i data/butik.json. Det är poängen med filen: en ny
   produkt är EN ny post i json-filen, ingen kodändring, ingen deploy av
   ny JS. När ägaren skickar en köplänk fylls "lank" i och "status" byts
   till "live" — den här modulen ritar då en köpknapp av sig själv.

   Appen tar ALDRIG betalt för fysiska varor. Köpknappen är en länk som
   öppnar kassan i en egen flik (target=_blank rel=noopener). Utan länk
   visar kortet "Snart i lager" och intresseanmälan — samma
   pv.wishlist.v1-lista och samma product_interest-tabell som Tillbehör-
   sektionen i Inställningar använde innan hyllan flyttade hit.

   Modulen laddas dynamiskt från app.js, precis som js/inst.js och av
   samma skäl: en butik är inte i klassen "appen får hellre dö än sakna
   den". Saknas filen i en utrullning visar vyn sin reservtext, och
   kartan, dashcamen och varningarna rullar vidare som om inget hänt.
   ===================================================================== */

import { CONFIG, hasBackend } from './config.js';
import { deviceId } from './store.js';

const NYCKEL = 'pv.wishlist.v1';

const STATUS_TEXT = {
  live: 'Kan beställas',
  coming: 'Snart i lager',
  idea: 'På idéstadiet',
};

/* Krokar från app.js. toast och e-post bor där; att importera hela
   app.js härifrån hade gjort cirkeln app→butik→app och det är exakt
   den sortens knut som ger "fungerar ibland" vid uppstart. */
let krokar = { toast: () => {}, epost: () => null };

let produkter = null;   // null = inte hämtad än, [] = hämtning misslyckades
let hamtning = null;    // pågående fetch, så två snabba vybyten inte hämtar dubbelt

export function start(k) {
  Object.assign(krokar, k || {});
  hamta();              // i bakgrunden vid boot — hyllan ska stå klar före första trycket
}

function hamta() {
  if (hamtning) return hamtning;
  hamtning = fetch('data/butik.json')
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then(j => { produkter = Array.isArray(j) ? j : (j.produkter || []); })
    .catch(() => { produkter = []; hamtning = null; }); // null igen: nästa rita() försöker om
  return hamtning;
}

/**
 * Rita hyllan. Anropas från showView('butik') varje gång fliken öppnas —
 * billigt nog (en handfull kort) och det är så "Meddela mig"-knappen
 * alltid visar rätt läge även om listan ändrats i en annan vy.
 */
export function rita() {
  const wrap = document.getElementById('butikLista');
  const tomt = document.getElementById('butikTomt');
  if (!wrap) return;

  if (produkter == null) {           // första gången, eller efter ett misslyckande
    hamta().then(rita);
    return;
  }

  wrap.innerHTML = '';
  if (tomt) tomt.hidden = produkter.length > 0;
  const valda = lasLista();

  for (const p of produkter) {
    const kort = document.createElement('div');
    kort.className = 'product';

    const bild = p.bild
      ? `<img class="prod-bild" src="${escapeHtml(p.bild)}" alt="" loading="lazy">`
      : `<div class="prod-ico">${escapeHtml(p.ikon || '📦')}</div>`;

    const kopbar = p.status === 'live' && typeof p.lank === 'string' && /^https:\/\//.test(p.lank);
    const status = STATUS_TEXT[p.status] || STATUS_TEXT.coming;

    kort.innerHTML =
      bild +
      `<div class="prod-body">` +
        `<div class="prod-head"><b>${escapeHtml(p.namn)}</b>` +
        `<span class="prod-price">${Number(p.pris) || 0} kr</span></div>` +
        `<div class="prod-tag">${escapeHtml(p.rad || '')}</div>` +
        (kopbar ? '' : `<span class="prod-status">${status}</span>`) +
      `</div>`;
    const kropp = kort.querySelector('.prod-body');

    if (kopbar) {
      /* En LÄNK och inte en knapp med window.open: popup-blockerare litar
         på en riktig <a href>, och webbläsaren visar vart den pekar. */
      const a = document.createElement('a');
      a.className = 'btn-kop';
      a.href = p.lank;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = `Köp — ${Number(p.pris) || 0} kr`;
      kropp.appendChild(a);
    } else {
      const btn = document.createElement('button');
      const pa = valda.includes(p.id);
      btn.className = 'btn-ghost small' + (pa ? ' chosen' : '');
      btn.type = 'button';
      btn.textContent = pa ? '✓ Du står på listan' : 'Meddela mig';
      btn.onclick = () => vaxlaIntresse(p, btn);
      kropp.appendChild(btn);
    }

    wrap.appendChild(kort);
  }
}

/**
 * Intresseanmälan i stället för köpknapp, för produkter utan länk.
 *
 * Lagret finns inte än. Att låta folk trycka "köp" på något som inte kan
 * skickas är ett säkert sätt att bränna förtroendet direkt. Intresset
 * säger dessutom hur många hållare som faktiskt ska beställas från Kina —
 * det är värt mer än en tidig krona.
 */
async function vaxlaIntresse(produkt, btn) {
  const lista = lasLista();
  const i = lista.indexOf(produkt.id);
  const laggerTill = i === -1;
  if (laggerTill) lista.push(produkt.id); else lista.splice(i, 1);
  try { localStorage.setItem(NYCKEL, JSON.stringify(lista)); } catch {}

  btn.className = 'btn-ghost small' + (laggerTill ? ' chosen' : '');
  btn.textContent = laggerTill ? '✓ Du står på listan' : 'Meddela mig';

  if (laggerTill) {
    krokar.toast(`Vi hör av oss när ${produkt.namn} finns i lager.`, 4000);
    if (hasBackend()) {
      try {
        await fetch(`${CONFIG.supabaseUrl}/rest/v1/product_interest`, {
          method: 'POST',
          headers: { apikey: CONFIG.supabaseAnonKey, Authorization: `Bearer ${CONFIG.supabaseAnonKey}`,
                     'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify({
            device_id: deviceId(), product: produkt.id,
            email: krokar.epost() || null, created_at: Date.now(),
          }),
        });
      } catch { /* intresset finns kvar lokalt */ }
    }
  }
}

function lasLista() {
  try { return JSON.parse(localStorage.getItem(NYCKEL)) || []; } catch { return []; }
}

/* Egen kopia, samma som js/map.js har. Att importera app.js för fem
   teckens ersättning vore cirkeln som beskrivs ovanför krokarna. */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const Butik = { start, rita };
