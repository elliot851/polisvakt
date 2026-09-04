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

/* Laddnings-skelett: n st kort i samma form som ett riktigt .product, med
   en skimrande platta i stället för innehåll. aria-hidden — en skärmläsare
   ska höra "laddar", inte tre tomma kort. */
function skelett(n) {
  const kort =
    '<div class="product prod-skeleton" aria-hidden="true">' +
      '<div class="sk sk-bild"></div>' +
      '<div class="sk-body">' +
        '<div class="sk sk-line" style="width:60%"></div>' +
        '<div class="sk sk-line short"></div>' +
        '<div class="sk sk-line" style="width:80%"></div>' +
      '</div>' +
    '</div>';
  return kort.repeat(n);
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
    // Skelett medan json:en hämtas. Kall första start är den enda gången det
    // hinner synas — annars är filen precachad och de riktiga korten står
    // direkt. Formen matchar .product så bytet inte hoppar. tomt-texten göms
    // så man inte ser "kunde inte läsas" blinka förbi före första försöket.
    if (tomt) tomt.hidden = true;
    wrap.innerHTML = skelett(3);
    hamta().then(rita);
    return;
  }

  stangDetalj();                     // tillbaka till hyllan varje gång fliken öppnas
  wrap.innerHTML = '';
  if (tomt) tomt.hidden = produkter.length > 0;
  const valda = lasLista();

  for (const p of produkter) {
    const kort = document.createElement('div');
    kort.className = 'product';

    const bild = huvudbild(p)
      ? `<img class="prod-bild" src="${escapeHtml(huvudbild(p))}" alt="" loading="lazy">`
      : `<div class="prod-ico">${escapeHtml(p.ikon || '📦')}</div>`;

    const kopbar = arKopbar(p);
    const status = STATUS_TEXT[p.status] || STATUS_TEXT.coming;

    kort.innerHTML =
      bild +
      `<div class="prod-body">` +
        `<div class="prod-head"><b>${escapeHtml(p.namn)}</b>` +
        `<span class="prod-price">${Number(p.pris) || 0} kr</span></div>` +
        `<div class="prod-tag">${escapeHtml(p.rad || '')}</div>` +
        (kopbar ? '' : `<span class="prod-status">${status}</span>`) +
      `</div>`;

    /* Hela kortet öppnar landningssidan. Knappen inuti får inte råka öppna
       den OCH göra sitt eget jobb — därför stopPropagation på knappen nedan. */
    kort.tabIndex = 0;
    kort.setAttribute('role', 'button');
    kort.setAttribute('aria-label', `${p.namn}, ${Number(p.pris) || 0} kronor — visa mer`);
    const oppna = () => visaDetalj(p);
    kort.addEventListener('click', oppna);
    kort.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); oppna(); }
    });

    const kropp = kort.querySelector('.prod-body');

    if (kopbar) {
      const a = document.createElement('a');
      a.className = 'btn-kop';
      a.href = p.lank;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = `Köp — ${Number(p.pris) || 0} kr`;
      a.addEventListener('click', e => e.stopPropagation());
      kropp.appendChild(a);
    } else {
      const btn = document.createElement('button');
      const pa = valda.includes(p.id);
      btn.className = 'btn-ghost small' + (pa ? ' chosen' : '');
      btn.type = 'button';
      btn.textContent = pa ? '✓ Du står på listan' : 'Meddela mig';
      btn.onclick = e => { e.stopPropagation(); vaxlaIntresse(p, btn); };
      kropp.appendChild(btn);
    }

    wrap.appendChild(kort);
  }
}

/* ---- Landningssidan för en produkt ---------------------------------- */

const STOR_ORD = { holder: '📱', mat: '⬛', scent: '🌿', sticker: '✨' };

function huvudbild(p) {
  if (Array.isArray(p.bilder) && p.bilder.length) return p.bilder[0];
  return p.bild || null;
}

function arKopbar(p) {
  return p.status === 'live' && typeof p.lank === 'string' && /^https:\/\//.test(p.lank);
}

/**
 * Öppnar en produkts landningssida INNE i butiksfliken — ingen router, inget
 * vybyte. Hyllan göms, #butikDetalj fylls och visas, och vyn rullas till
 * toppen så man inte landar mitt i en sida. En äkta landningssida byggd av
 * det som faktiskt finns i json-raden: saknas ett fält ritas inte dess block.
 */
function visaDetalj(p) {
  const hylla = document.getElementById('butikHylla');
  const box = document.getElementById('butikDetalj');
  const vy = document.getElementById('view-butik');
  if (!box || !hylla) return;

  const kopbar = arKopbar(p);
  const pris = Number(p.pris) || 0;
  const bilder = (Array.isArray(p.bilder) && p.bilder.length) ? p.bilder
                : (p.bild ? [p.bild] : []);

  const hjaltebild = bilder.length
    ? `<img src="${escapeHtml(bilder[0])}" alt="${escapeHtml(p.namn)}" class="pd-hjalte-bild">`
    : `<div class="pd-hjalte-ico">${escapeHtml(p.ikon || STOR_ORD[p.id] || '📦')}</div>`;

  const miniatyrer = bilder.length > 1
    ? `<div class="pd-thumbs">` + bilder.map((b, i) =>
        `<button class="pd-thumb${i === 0 ? ' vald' : ''}" type="button" data-i="${i}">` +
        `<img src="${escapeHtml(b)}" alt="" loading="lazy"></button>`).join('') + `</div>`
    : '';

  // Lagerraden — bara ett ärligt besked. Antal visas när varan går att köpa;
  // annars säger den vad status faktiskt är, inte en påhittad siffra.
  let lagerrad;
  // p.lager != null && !== '' innan Number(): Number('') är 0 (finit), så en tom
  // lagersträng visade förr "Bara 0 kvar i lager" på en köpbar vara.
  if (kopbar && p.lager != null && p.lager !== '' && Number.isFinite(Number(p.lager))) {
    const n = Number(p.lager);
    const lag = n <= 10;
    lagerrad = `<span class="pd-lager${lag ? ' fa' : ''}">● ${lag ? `Bara ${n} kvar i lager` : `${n} i lager`}</span>`;
  } else if (kopbar) {
    lagerrad = `<span class="pd-lager">● I lager</span>`;
  } else {
    lagerrad = `<span class="pd-lager kommer">● ${escapeHtml(STATUS_TEXT[p.status] || STATUS_TEXT.coming)}</span>`;
  }

  const punkter = Array.isArray(p.punkter) && p.punkter.length
    ? `<ul class="pd-punkter">` + p.punkter.map(t =>
        `<li>${escapeHtml(t)}</li>`).join('') + `</ul>`
    : '';

  const beskrivning = p.beskrivning
    ? `<p class="pd-text">${escapeHtml(p.beskrivning)}</p>` : '';

  // Trygghetsraden — leverans, frakt, garanti. Bara de fält som finns.
  const trygg = [
    p.leverans ? ['🚚', 'Leverans', p.leverans] : null,
    p.frakt    ? ['📦', 'Frakt', p.frakt] : null,
    p.garanti  ? ['↩️', 'Trygghet', p.garanti] : null,
    ['🔒', 'Betalning', 'Sker hos kassan — appen ser aldrig ditt kort'],
  ].filter(Boolean).map(([ik, r, v]) =>
    `<div class="pd-trygg-rad"><span class="pd-trygg-ico">${ik}</span>` +
    `<div><b>${escapeHtml(r)}</b><span>${escapeHtml(v)}</span></div></div>`).join('');

  box.innerHTML =
    `<button class="pd-tillbaka" type="button" id="pdTillbaka">‹ Tillbaka till butiken</button>` +
    `<div class="pd-hjalte">${hjaltebild}</div>` +
    miniatyrer +
    `<div class="pd-huvud">` +
      `<h1 class="pd-namn">${escapeHtml(p.namn)}</h1>` +
      `<div class="pd-prisrad"><span class="pd-pris">${pris} kr</span>${lagerrad}</div>` +
    `</div>` +
    beskrivning +
    punkter +
    `<div class="pd-kop"></div>` +
    `<div class="pd-trygg">${trygg}</div>`;

  // Köpknappen / intresseanmälan — samma logik som på kortet, men stor.
  const kopruta = box.querySelector('.pd-kop');
  if (kopbar) {
    const a = document.createElement('a');
    a.className = 'btn-kop stor';
    a.href = p.lank; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = `Köp nu — ${pris} kr`;
    kopruta.appendChild(a);
  } else {
    const btn = document.createElement('button');
    const pa = lasLista().includes(p.id);
    btn.className = 'btn-kop stor sekundar' + (pa ? ' chosen' : '');
    btn.type = 'button';
    btn.textContent = pa ? '✓ Du står på listan — vi hör av oss' : 'Meddela mig när den släpps';
    btn.onclick = () => vaxlaIntresse(p, btn, true);
    kopruta.appendChild(btn);
  }

  box.querySelector('#pdTillbaka').addEventListener('click', stangDetalj);
  box.querySelectorAll('.pd-thumb').forEach(t => t.addEventListener('click', () => {
    const i = Number(t.dataset.i) || 0;
    const stor = box.querySelector('.pd-hjalte-bild');
    if (stor && bilder[i]) stor.src = bilder[i];
    box.querySelectorAll('.pd-thumb').forEach(x => x.classList.toggle('vald', x === t));
  }));

  hylla.hidden = true;
  box.hidden = false;
  if (vy) vy.scrollTop = 0;
}

function stangDetalj() {
  const hylla = document.getElementById('butikHylla');
  const box = document.getElementById('butikDetalj');
  if (box) { box.hidden = true; box.innerHTML = ''; }
  if (hylla) hylla.hidden = false;
}

/**
 * Intresseanmälan i stället för köpknapp, för produkter utan länk.
 *
 * Lagret finns inte än. Att låta folk trycka "köp" på något som inte kan
 * skickas är ett säkert sätt att bränna förtroendet direkt. Intresset
 * säger dessutom hur många hållare som faktiskt ska beställas från Kina —
 * det är värt mer än en tidig krona.
 */
async function vaxlaIntresse(produkt, btn, stor = false) {
  const lista = lasLista();
  const i = lista.indexOf(produkt.id);
  const laggerTill = i === -1;
  if (laggerTill) lista.push(produkt.id); else lista.splice(i, 1);
  try { localStorage.setItem(NYCKEL, JSON.stringify(lista)); } catch {}

  // Knappen finns i två storlekar — hyllkortets lilla och landningssidans
  // stora. Behåll den form knappen redan hade i stället för att platta den.
  btn.className = stor
    ? 'btn-kop stor sekundar' + (laggerTill ? ' chosen' : '')
    : 'btn-ghost small' + (laggerTill ? ' chosen' : '');
  btn.textContent = stor
    ? (laggerTill ? '✓ Du står på listan — vi hör av oss' : 'Meddela mig när den släpps')
    : (laggerTill ? '✓ Du står på listan' : 'Meddela mig');

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
