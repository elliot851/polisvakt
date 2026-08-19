// Introduktionsguide.
//
// Körs en gång, direkt efter att kontot skapats. Den mörklägger skärmen och
// klipper ut ett hål över exakt den knapp som förklaras, med en pil som pekar
// dit. Poängen är att ingen ska behöva gissa vad en ikon gör medan bilen
// rullar — allt ska sitta i huvudet innan man kör.
//
// Stegen pekar på riktiga element via id. Saknas ett element (till exempel
// dashcam på en telefon utan kamerastöd) hoppas steget tyst över istället för
// att guiden går sönder.
//
// Tre av stegen är behörighetssteg (`perm`). De ligger först med flit: en app
// utan plats varnar inte för någonting, och resten av guiden beskriver då
// funktioner som inte finns. De stegen ritar en extra ruta i kortet med
// nuläget och en knapp som frågar på riktigt — se #renderPerm. Sanningen om
// tillstånden bor i js/behorigheter.js, inte här.

import * as behorigheter from './behorigheter.js';
import { deviceId } from './store.js';

const KEY = 'pv.tour.v1';

export const STEPS = [
  {
    title: 'Välkommen till Polisvakt',
    body: 'Appen varnar dig med rösten så att du kan hålla blicken på vägen. Den här guiden tar en minut och visar exakt hur allt fungerar. Svep aldrig i appen medan du kör — allt viktigt hörs.',
    target: null,
  },
  {
    title: 'Plats — utan den vet appen ingenting',
    body: 'Polisvakt behöver din position till två saker: veta vad som ligger framför dig, och märka när du börjat köra. Utan plats kommer inga varningar alls, och appen kan aldrig lära sig när du brukar köra — då går det inte att påminna dig om att slå på den heller. Tryck här nedanför, så frågar telefonen.',
    perm: 'plats',
    target: null,
  },
  {
    title: 'Notiser — det enda som når dig när appen är stängd',
    body: 'Rakt på sak: appen varnar inte i bakgrunden. Är den stängd läser den varken GPS eller karta, och då är den tyst. Notiser är enda kanalen som når fram ändå, och de används till två saker — påminnelsen att slå på appen innan du kör, och ett pling när polis rapporterats i närheten. Säger du nej här är båda borta.',
    perm: 'notiser',
    target: null,
  },
  {
    title: 'Fokus och Stör ej — den alla missar',
    body: 'Du kan ha sagt ja till notiser och ändå aldrig höra ett pling, för att telefonens fokusläge filtrerar bort dem. iPhone slår dessutom på fokuset Kör bil av sig själv när den märker att du sitter i en bil — precis när appen ska höras. Den inställningen kan appen inte läsa, så den här punkten måste du kolla själv.',
    perm: 'fokus',
    target: null,
  },
  {
    title: 'Kartan visar allt i närheten',
    body: 'Den blå pilen är du. Röda markörer är polis och kontroller, gula är fartkameror. Färska rapporter pulserar, gamla bleknar bort av sig själv — så det du ser är alltid det som fortfarande gäller.',
    // Inget hål här: kartan fyller hela skärmen, så en utklippt ruta hade
    // bara mörklagt kanterna utan att peka på något.
    target: null,
  },
  {
    title: 'Hastighet och gräns',
    body: 'Till vänster din fart, bredvid den skylten för vägen du kör på. Siffran blir gul när du ligger över gränsen och röd när du ligger klart över. Då säger rösten till en gång — inte gång på gång.',
    target: 'speedo',
    place: 'below',
  },
  {
    title: 'Statuslamporna',
    body: 'GPS betyder att positionen hittats. Röst att mikrofonen lyssnar. Nät att du är kopplad till de andra förarna — står det Delat i grönt går dina rapporter ut till alla i Västmanland.',
    target: 'chips',
    place: 'below',
  },
  {
    title: 'Rapportera med ett tryck',
    body: 'Tre knappar för det du ser: polis, kontroll och civil polisbil. Ett tryck räcker — appen tar din position själv. Fartkameror behöver du inte rapportera, alla 136 i Västmanland finns redan inlagda.',
    target: 'actions',
    place: 'above',
  },
  {
    title: 'Tala istället för att trycka',
    body: 'Den blå knappen. Tryck och säg vad du ser: "polis vid Dillos", "civil här", "kontroll Erikslund". Slår du på väckningsordet i inställningarna räcker det att säga "Hej vakt" — då behöver du aldrig röra telefonen.',
    target: 'btnMic',
    place: 'above',
  },
  {
    title: 'Tysta snabbt',
    body: 'Högtalarknappen tystar varningarna i femton minuter. Akuta varningar hörs ändå. Musiken dämpas bara när appen säger något, sedan kommer den tillbaka — som ett trafikmeddelande på radion.',
    target: 'btnMute',
    place: 'below',
  },
  {
    title: 'Listan under kartan',
    body: 'Allt i närheten sorterat efter avstånd, med hur gammal uppgiften är. Kör du förbi och faran står kvar — tryck "Finns kvar", då lever varningen längre. Är det tomt — tryck "Borta". Tre sådana och varningen försvinner för alla. Det är det som gör listan pålitlig.',
    target: 'sheet',
    place: 'above',
  },
  {
    title: 'Dashcam',
    body: 'Bakkameran filmar framåt genom vindrutan med ljud. Den spelar i loop och raderar det äldsta automatiskt. Vid en smäll låses filmen av sig själv — du behöver inte trycka på något mitt i en krock.',
    target: 'tab-dashcam',
    place: 'above',
  },
  {
    title: 'Inställningar',
    body: 'Här justerar du hur tidigt varningar kommer, hur rösten låter och hur känslig krockdetekteringen är. Där finns också en testknapp så du kan höra alla varningar innan du kör.',
    target: 'tab-settings',
    place: 'above',
  },
  {
    title: 'Vad vi inte rapporterar',
    body: 'Nykterhets- och drogkontroller går inte att lägga upp här. Att varna för en fartkamera hjälper dig hålla hastigheten — att varna för en nykterhetskontroll hjälper någon köra vidare full. Appen vägrar sådana rapporter, oavsett hur de skickas in.',
    target: null,
  },
  {
    title: 'Klart',
    body: 'Sätt telefonen i en hållare, starta dashcammen om du vill filma, och kör. Rapporterna från alla andra kommer automatiskt. Kör efter skyltarna — appen är en hjälp, inte ett facit.',
    target: null,
  },
];

export const seen = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
export const markSeen = () => { try { localStorage.setItem(KEY, '1'); } catch {} };
export const reset = () => { try { localStorage.removeItem(KEY); } catch {} };

/* ---- Små byggstenar för behörighetsrutan ----
   Guiden får bara röra sina egna element, och css/app.css ägs av någon annan.
   Därför byggs rutan med inline-stil ur samma variabler som resten av
   temat — inga nya klassnamn, inget som krockar. */

function el(tag, style, text) {
  const n = document.createElement(tag);
  if (style) n.style.cssText = style;
  if (text != null) n.textContent = text;   // aldrig innerHTML
  return n;
}

const FARG = { ok: 'var(--ok)', fel: 'var(--danger)', vanta: 'var(--warn)' };

function statusrad(p) {
  const farg = p.ok ? FARG.ok : (p.state === 'denied' || p.state === 'saknas') ? FARG.fel : FARG.vanta;
  const rad = el('div',
    'display:flex;align-items:center;gap:9px;background:var(--bg-3);' +
    'border:1px solid var(--line);border-radius:12px;padding:10px 12px;');
  rad.append(
    el('span', `width:9px;height:9px;border-radius:50%;flex:none;background:${farg};box-shadow:0 0 8px ${farg};`),
    el('span', 'font-size:13.5px;font-weight:600;color:var(--fg);', `${p.namn}: ${p.text}`),
  );
  return rad;
}

function menyvag(vad) {
  const { rubrik, steg, not } = behorigheter.instruktioner(vad);
  const box = el('div', 'border-top:1px solid var(--line);padding-top:11px;');
  box.append(el('div',
    'font-size:11px;text-transform:uppercase;letter-spacing:.09em;' +
    'color:var(--accent);font-weight:700;margin-bottom:7px;', rubrik));
  const ol = el('ol', 'margin:0;padding-left:18px;font-size:13px;line-height:1.55;color:var(--fg-dim);');
  steg.forEach(s => ol.append(el('li', 'margin-bottom:4px;', s)));
  box.append(ol);
  if (not) box.append(el('p', 'font-size:12.5px;line-height:1.5;color:#7f8fa1;margin:9px 0 0;', not));
  return box;
}

export class Tour extends EventTarget {
  #permToken = 0;
  // Senaste misslyckade försöket, så att svaret från telefonen inte försvinner
  // när rutan ritas om direkt efteråt. { nyckel, text }
  #fel = null;

  constructor(opts = {}) {
    super();
    this.steps = opts.steps || STEPS;
    this.index = 0;
    this.running = false;
    this.onShowView = opts.onShowView || (() => {});
    // Vanorna från driving.js, om anroparen har dem. Skickas vidare till
    // push.js så att första prenumerationen får med kända körtider direkt.
    this.habits = opts.habits || null;
    this._resize = () => this.#position();
    // Tillståndet kan ändras utanför guiden — systemrutan besvaras, eller
    // användaren går ut i inställningarna och tillbaka. Rita om då.
    this._behorighet = () => { if (this.running) this.#renderPerm(this.steps[this.index]); };
  }

  start(from = 0) {
    this.index = from;
    this.running = true;
    document.getElementById('tour').hidden = false;
    document.body.classList.add('tour-open');
    addEventListener('resize', this._resize);
    addEventListener('orientationchange', this._resize);
    behorigheter.events.addEventListener('andrad', this._behorighet);
    this.#render();
  }

  stop() {
    this.running = false;
    document.getElementById('tour').hidden = true;
    document.body.classList.remove('tour-open');
    removeEventListener('resize', this._resize);
    removeEventListener('orientationchange', this._resize);
    behorigheter.events.removeEventListener('andrad', this._behorighet);
    this.#permToken++;                       // kasta svar som är på väg in
    const card = document.getElementById('tourCard');
    if (card) { card.style.maxHeight = ''; card.style.overflowY = ''; }
    markSeen();
    this.dispatchEvent(new CustomEvent('done'));
  }

  next() {
    // Hoppa förbi steg vars element inte finns på den här telefonen
    let i = this.index + 1;
    while (i < this.steps.length && this.steps[i].target && !this.#el(this.steps[i].target)) i++;
    if (i >= this.steps.length) { this.stop(); return; }
    this.index = i;
    this.#fel = null;
    this.#render();
  }

  back() {
    let i = this.index - 1;
    while (i > 0 && this.steps[i].target && !this.#el(this.steps[i].target)) i--;
    this.index = Math.max(0, i);
    this.#fel = null;
    this.#render();
  }

  #el(target) {
    if (!target) return null;
    if (target === 'tab-dashcam') return document.querySelector('.tab[data-view="dashcam"]');
    if (target === 'tab-settings') return document.querySelector('.tab[data-view="settings"]');
    return document.getElementById(target);
  }

  #render() {
    const step = this.steps[this.index];
    const total = this.steps.length;

    // Guiden förklarar kartvyn, så se till att den syns bakom mörkläggningen
    this.onShowView('map');

    document.getElementById('tourStep').textContent = `${this.index + 1} av ${total}`;
    document.getElementById('tourTitle').textContent = step.title;
    document.getElementById('tourBody').textContent = step.body;
    document.getElementById('tourBack').hidden = this.index === 0;
    document.getElementById('tourNext').textContent =
      this.index === total - 1 ? 'Kör igång' : 'Nästa';

    const dots = document.getElementById('tourDots');
    dots.innerHTML = this.steps
      .map((_, i) => `<span class="${i === this.index ? 'on' : ''}"></span>`).join('');

    this.#renderPerm(step);
    this.#position();
  }

  /* ---------------------- Behörighetsstegen ------------------------- */

  /**
   * Rutan mellan brödtexten och knappraden. Skapas en gång och återanvänds.
   * Den ligger FÖRE .tour-actions med flit — "Nästa" ska sitta kvar längst ner
   * där fingret redan väntar, oavsett hur hög rutan blir.
   */
  #permBox() {
    let box = document.getElementById('tourPerm');
    if (!box) {
      box = el('div', 'margin-top:15px;display:grid;gap:11px;');
      box.id = 'tourPerm';
      document.getElementById('tourBody').insertAdjacentElement('afterend', box);
    }
    return box;
  }

  /**
   * Läs av läget och rita om rutan.
   *
   * Två ritningar med flit: snabbStatus() svarar direkt, full status() väntar
   * på service workern och kan ta sekunder på en telefon där den sover. Utan
   * den första blinkar rutan tom precis när användaren läser rubriken.
   *
   * #permToken kastar svar som hinner komma efter att man tryckt Nästa —
   * annars ritas plats-status i notissteget.
   */
  async #renderPerm(step) {
    const box = this.#permBox();
    const card = document.getElementById('tourCard');
    const token = ++this.#permToken;

    if (!step?.perm) {
      box.hidden = true;
      box.replaceChildren();
      card.style.maxHeight = '';
      card.style.overflowY = '';
      return;
    }

    // Menyvägar gör kortet högt på en liten skärm. Låt det rulla istället för
    // att knapparna hamnar utanför bild.
    box.hidden = false;
    card.style.maxHeight = 'calc(100vh - 24px)';
    card.style.overflowY = 'auto';

    try {
      const snabb = await behorigheter.snabbStatus();
      if (token !== this.#permToken) return;
      this.#drawPerm(box, step.perm, snabb);

      const full = await behorigheter.status();
      if (token !== this.#permToken) return;
      this.#drawPerm(box, step.perm, full);
    } catch {
      // Går statusen inte att läsa ska guiden ändå gå att slutföra.
      if (token === this.#permToken) box.replaceChildren();
    }
  }

  #drawPerm(box, nyckel, st) {
    const p = st[nyckel];
    const delar = [statusrad(p)];

    if (p.reason) {
      delar.push(el('p', 'font-size:13px;line-height:1.5;color:var(--fg-dim);margin:0;', p.reason));
    }
    if (this.#fel?.nyckel === nyckel && this.#fel.text) {
      delar.push(el('p', 'font-size:13px;line-height:1.5;color:var(--warn);margin:0;', this.#fel.text));
    }

    const knappar = el('div', 'display:flex;gap:9px;flex-wrap:wrap;');
    const primar = (text, fn) => {
      const b = el('button', 'flex:1;min-width:150px;', text);
      b.type = 'button';
      b.className = 'btn-primary';
      b.onclick = () => fn(b);
      return b;
    };
    const ghost = (text, fn) => {
      const b = el('button', null, text);
      b.type = 'button';
      b.className = 'btn-ghost small';
      b.onclick = () => fn(b);
      return b;
    };

    // Visa menyvägen direkt när tillståndet är nekat — då finns ingen knapp
    // som hjälper, webbläsaren frågar aldrig igen. Fokus visar den alltid,
    // eftersom hela steget går ut på att användaren ska gå in och kolla.
    let visaVag = (!p.ok && !p.kanFraga) || (nyckel === 'fokus' && !p.ok);

    if (nyckel === 'plats') {
      if (p.kanFraga) {
        // Anropet ligger direkt i klickhanteraren. Safari kräver en levande
        // gest för att visa platsrutan — läggs det ett await före hinner
        // gesten gå ut och ingenting händer.
        knappar.append(primar(
          p.state === 'okand' ? 'Kontrollera plats' : 'Tillåt plats',
          async b => {
            b.disabled = true;
            b.textContent = 'Väntar på telefonen…';
            const res = await behorigheter.begarPlats();
            this.#fel = res.ok || res.state === 'denied' ? null : { nyckel, text: res.reason };
            this.#renderPerm(this.steps[this.index]);
          }));
      }
    }

    if (nyckel === 'notiser') {
      if (p.kanFraga) {
        knappar.append(primar('Slå på notiser', async b => {
          b.disabled = true;
          let id = null;
          try { id = deviceId(); } catch {}
          // Ingen await före det här — frågan om lov måste ligga i gesten.
          const res = await behorigheter.begarNotiser({ deviceId: id, habits: this.habits });
          // Även ett lyckat svar kan ha något att säga — till exempel att
          // tillståndet finns men att servern inte kan skicka påminnelser än.
          this.#fel = res.reason ? { nyckel, text: res.reason } : null;
          this.#renderPerm(this.steps[this.index]);
        }));
      } else if (!p.ok && p.fix === 'hemskarm') {
        visaVag = true;                       // iPhone i Safari-flik
      }
    }

    if (nyckel === 'fokus') {
      if (p.ok) {
        knappar.append(ghost('Kolla igen', () => {
          behorigheter.bekraftaFokus(false);
          this.#renderPerm(this.steps[this.index]);
        }));
      } else {
        // Ingen systemruta finns att visa här. Knappen sparar bara att
        // användaren varit inne och tittat — det är den enda sanning vi kan
        // få, och den märks som obekräftad i behorigheter.js.
        knappar.append(primar('Jag har kollat inställningen', () => {
          behorigheter.bekraftaFokus(true);
          this.#renderPerm(this.steps[this.index]);
        }));
      }
    }

    if (!visaVag && !p.ok) {
      knappar.append(ghost('Visa var det sitter', () => {
        box.append(menyvag(nyckel));
        this.#position();
      }));
    }

    if (knappar.childElementCount) delar.push(knappar);
    if (visaVag) delar.push(menyvag(nyckel));

    box.replaceChildren(...delar);
  }

  /** Klipp hål över målet, placera pil och kort så de inte skymmer. */
  #position() {
    const step = this.steps[this.index];
    const hole = document.getElementById('tourHoleRect');
    const ring = document.getElementById('tourRing');
    const arrow = document.getElementById('tourArrow');
    const card = document.getElementById('tourCard');

    const el = this.#el(step.target);
    if (!el) {
      hole.setAttribute('width', '0');
      hole.setAttribute('height', '0');
      ring.hidden = true;
      arrow.hidden = true;
      card.style.top = ''; card.style.bottom = '';
      card.classList.add('centered');
      return;
    }
    card.classList.remove('centered');

    const r = el.getBoundingClientRect();
    const pad = 8;
    const x = Math.max(0, r.left - pad);
    const y = Math.max(0, r.top - pad);
    const w = Math.min(innerWidth, r.width + pad * 2);
    const h = Math.min(innerHeight, r.height + pad * 2);

    hole.setAttribute('x', x); hole.setAttribute('y', y);
    hole.setAttribute('width', w); hole.setAttribute('height', h);

    ring.hidden = false;
    ring.style.cssText =
      `left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;

    // Kortet hamnar på motsatt sida av det vi pekar på
    const below = step.place === 'below' || (step.place !== 'above' && r.top < innerHeight / 2);
    card.style.top = below ? `${Math.min(innerHeight - 260, y + h + 26)}px` : '';
    card.style.bottom = below ? '' : `${Math.min(innerHeight - 160, innerHeight - y + 26)}px`;

    arrow.hidden = false;
    arrow.textContent = below ? '▲' : '▼';
    arrow.style.left = `${Math.min(innerWidth - 40, Math.max(20, x + w / 2 - 12))}px`;
    arrow.style.top = below ? `${y + h + 4}px` : `${y - 30}px`;
  }
}
