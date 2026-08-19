// Kartrotation — tvåfingersvridning, norrknapp och kör-upp-läge.
//
// ─────────────────────────────────────────────────────────────────────────────
// VARFÖR DEN HÄR FILEN FINNS, OCH VARFÖR DEN SER UT SÅ HÄR
// ─────────────────────────────────────────────────────────────────────────────
//
// Leaflet 1.9.4 kan inte rotera. Det finns ingen `map.setBearing()`, ingen
// dold flagga, ingenting. Rutnätet med kartbrickor utgår från att norr är
// uppåt, markörer placeras i oroterade pixelkoordinater, och all
// klick-till-position-matte antar samma sak.
//
// Tre vägar fanns:
//
//   1. Byta kartlager till något vektorbaserat (MapLibre GL) som roterar
//      inbyggt. Renast tekniskt — och helt fel här. Det är ett nytt beroende
//      på ~800 kB som måste vendoras in i repot, en ny brick-källa, en ny
//      stilfil, och hela app.js/css/app.css skulle behöva skrivas om kring en
//      annan karta. Dessutom kostar WebGL batteri och GPU i en telefon som
//      samtidigt spelar in video och pratar.
//
//   2. Ta in ett rotationsplugin (leaflet-rotate). Det skriver om ett trettiotal
//      privata Leaflet-metoder och är låst till exakt en Leaflet-version. Det
//      får inte hämtas från CDN (service workern förhandscachar appskalet), och
//      index.html ägs inte av den här ändringen — vi kan alltså inte lägga till
//      ett <script>. Ett vendorat plugin på ~40 kB som vi ändå måste underhålla
//      själva ger sämre kontroll än att skriva det lilla vi behöver.
//
//   3. Rotera kartrutan med CSS och rätta till det som går sönder. Vald väg.
//      Det som faktiskt går sönder är färre saker än man tror — se nedan.
//
// SÅ HÄR FUNGERAR DET
//
//   DOM:  #map (klipper, syns)
//           └─ .pv-map        ← Leafletbehållaren. ALDRIG roterad. All
//              │                skärmkoordinat-matte utgår från dess rect.
//              ├─ .pv-rotor   ← roteras med transform: rotate()
//              │    └─ .leaflet-map-pane (brickor, markörer, canvas)
//              └─ .leaflet-control-container  ← utanför rotorn, står upprätt
//
//   En roterad rektangel täcker inte längre skärmen — hörnen blir tomma. Därför
//   förstoras Leafletbehållaren till en kvadrat med skärmens diagonal som sida,
//   centrerad, medan #map klipper bort överskottet. Då tror Leaflet att kartan
//   är större än den syns, och laddar brickor, ritar canvas och räknar
//   pixelgränser för hela den ytan. Allt som utgår från `map.getSize()` blir
//   automatiskt rätt. Priset är fler brickor — se docs/KARTA.md.
//
//   Fyra saker måste rättas för hand:
//     • containerPointToLayerPoint / layerPointToContainerPoint — annars landar
//       varje tryck på fel plats på kartan.
//     • Renderer._update — den enda inbyggda som vill ha den OROTERADE
//       omräkningen. Får den den roterade hamnar canvasytan snett och cirklar
//       klipps bort.
//     • Dragvektorn — Leaflet flyttar kartrutan med fingrets skärmvektor. I en
//       roterad ruta betyder det att kartan glider snett. Vektorn roteras
//       tillbaka.
//     • touchZoom = 'center' medan kartan är vriden — Leaflets nypzoom räknar
//       en skärmvektor i projicerade koordinater, vilket driver iväg. Zoom mot
//       mitten är dessutom rätt beteende i bil, där bilen ligger i mitten.
//
//   Allt som ritas på kartan motroteras med en enda nedärvd CSS-variabel
//   (--pv-anti). En stilskrivning per bildruta räcker för samtliga markörer,
//   i stället för att bygga om varje ikon. Ingen omflödning uppstår — bara
//   transform, aldrig layout.

const LS_KEY = 'pv.karta.v1';

const TWIST_START_DEG = 12;    // så mycket måste man vrida innan rotationen tar vid
const SNAP_DEG = 5;            // nära nog norr när fingrarna släpper → snäpp dit
const COURSE_MIN_KMH = 12;     // under detta är GPS-kursen skräp
const COURSE_DEADBAND_DEG = 3; // små kursryck ska inte röra kartan alls
const STOP_KMH = 5;
const STOP_RESUME_MS = 60000;  // stillastående så länge = ny körning, kör-upp får komma tillbaka
const TAU_COURSE_MS = 260;     // mjukhet i kör-upp
const TAU_NORTH_MS = 380;      // mjukhet när man trycker på kompassen
const LOOKAHEAD = 0.15;        // hur långt ner på skärmen bilen ligger i kör-upp
const LONGPRESS_MS = 550;

const norm360 = d => ((d % 360) + 360) % 360;
const norm180 = d => { const x = norm360(d); return x > 180 ? x - 360 : x; };

/** Rotera en pixelvektor medurs (skärmens y pekar nedåt). */
function turn(p, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return L.point(p.x * c - p.y * s, p.x * s + p.y * c);
}

const load = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } };
const save = v => { try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch {} };

/**
 * Roterar en Leafletkarta.
 *
 * `bearing` är den kompassriktning som pekar UPPÅT på skärmen. 0 = norr uppåt.
 * CSS-vinkeln är alltså −bearing: ska öster (90°) hamna uppåt måste innehållet
 * vridas 90° moturs.
 */
export class MapRotation extends EventTarget {
  constructor(map, { outer, container, host, tileLayer }) {
    super();
    this.map = map;
    this.outer = outer;              // #map — klipper
    this.container = container;      // Leafletbehållaren
    this.host = host || outer;       // där klass och CSS-variabler skrivs
    this.tileLayer = tileLayer || null;

    const pref = load();
    // Kör-upp är på från början. Det är hela poängen med rotation i bil: en
    // varning "till höger" ska ligga till höger både på skärmen och genom
    // vindrutan. Den som inte vill ha det trycker en gång på kompassen.
    this.courseUp = pref.courseUp !== false;

    this.bearing = 0;
    this.mode = 'north';             // 'north' | 'manual' | 'course'

    this._target = 0;
    this._tau = TAU_COURSE_MS;
    this._animating = false;
    this._raf = 0;
    this._lastTs = 0;
    this._painted = null;
    this._anti = null;

    this._active = false;            // CSS-rotation påslagen (även vid exakt 0 under utfasning)
    this._raw = false;               // sant medan Leaflet vill ha oroterad matte
    this._over = false;              // förstorad behållare
    this._pad = { x: 0, y: 0 };
    this._settleTimer = 0;
    this._animTimer = 0;

    this._paused = false;            // föraren har tryckt på kompassen
    this._stillSince = 0;

    this.view = { w: outer.clientWidth || 1, h: outer.clientHeight || 1 };

    this.#styles();
    this.#rotor();
    this.#patchMap();
    this.#buildUi();
    this.#wireGesture();
    this.#observeSize();
    this.#syncUi();
  }

  /* ================= Läsbart tillstånd ================= */

  get cssAngle() { return -this.bearing; }
  get rotated() { return Math.abs(norm180(this.bearing)) > 0.5; }
  get active() { return this._active; }

  /* ================= DOM ================= */

  #styles() {
    if (document.getElementById('pv-kartrot-css')) return;
    const s = document.createElement('style');
    s.id = 'pv-kartrot-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /**
   * Skjut in rotorn mellan behållaren och kartrutan. Kontrollerna (zoom,
   * upphovsrätt) blir kvar utanför och står därmed alltid upprätt.
   */
  #rotor() {
    this.outer.classList.add('pv-map-clip');
    this.container.classList.add('pv-map');

    const pane = this.map._mapPane;
    const rotor = document.createElement('div');
    rotor.className = 'pv-rotor';
    this.container.insertBefore(rotor, pane);
    rotor.appendChild(pane);
    this.rotor = rotor;

    // Brickorna växer en pixel när kartan är vriden. Utan det syns hårfina
    // mörka sömmar mellan dem — subpixelavrundning i en roterad transform.
    const t = this.tileLayer?.getTileSize?.().x || 256;
    this.host.style.setProperty('--pv-tile', (t + 1) + 'px');
  }

  #buildUi() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pv-compass';
    btn.setAttribute('aria-label', 'Rikta kartan norrut');
    btn.title = 'Tryck: norrut. Håll in: slå av eller på kör-upp.';
    btn.innerHTML = `<svg viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="18" fill="none" stroke="currentColor" stroke-opacity=".22" stroke-width="1.5"/>
      <polygon points="20,5 26,23 20,19.5 14,23" fill="#ff4d4f"/>
      <polygon points="20,35 14,17 20,20.5 26,17" fill="#8fa3b6"/>
    </svg>`;
    this.compass = btn;

    const hint = document.createElement('div');
    hint.className = 'pv-hint';
    hint.setAttribute('role', 'status');
    this.hintEl = hint;

    this.host.appendChild(btn);
    this.host.appendChild(hint);

    // Kort tryck = norrut. Långt tryck = slå av/på kör-upp helt. Två
    // funktioner på en knapp, för det finns ingen plats till fler i vyn och
    // inställningsvyn ägs av någon annan.
    let timer = 0, long = false;
    const down = () => {
      long = false;
      clearTimeout(timer);
      timer = setTimeout(() => { long = true; this.toggleCourseUp(); }, LONGPRESS_MS);
    };
    const up = e => {
      clearTimeout(timer);
      if (long) { e.preventDefault(); return; }
    };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', () => clearTimeout(timer));
    btn.addEventListener('pointerleave', () => clearTimeout(timer));
    btn.addEventListener('contextmenu', e => e.preventDefault());
    btn.addEventListener('click', e => {
      e.preventDefault();
      if (long) { long = false; return; }
      this.north();
    });
  }

  #hint(text, ms = 3400) {
    if (!this.hintEl) return;
    this.hintEl.textContent = text;
    this.hintEl.classList.add('show');
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => this.hintEl.classList.remove('show'), ms);
  }

  #syncUi() {
    const show = this.rotated || this.mode === 'course';
    this.compass.classList.toggle('show', show);
    this.compass.classList.toggle('course', this.mode === 'course');
  }

  /* ================= Leaflet-lagningarna ================= */

  #patchMap() {
    const map = this.map;
    this._origTouchZoom = map.options.touchZoom;

    // Skärmpunkt → lagerpunkt. Rotationen sker kring behållarens mitt, som
    // tack vare den symmetriska förstoringen är exakt samma punkt som den
    // synliga rutans mitt.
    map.containerPointToLayerPoint = point => {
      const p = L.point(point);
      const pane = map._getMapPanePos();
      if (!this._active || this._raw) return p.subtract(pane);
      const c = map.getSize().divideBy(2);
      return turn(p.subtract(c), -this.cssAngle).add(c).subtract(pane);
    };

    map.layerPointToContainerPoint = point => {
      const p = L.point(point).add(map._getMapPanePos());
      if (!this._active || this._raw) return p;
      const c = map.getSize().divideBy(2);
      return turn(p.subtract(c), this.cssAngle).add(c);
    };

    // Canvas- och SVG-renderaren är den enda inbyggda som vill ha den
    // OROTERADE omräkningen: den räknar ut en axelparallell ruta i lagerrymden
    // och skulle med roterade hörn hamna snett, så att cirklar klipps bort.
    const origGetRenderer = map.getRenderer.bind(map);
    map.getRenderer = layer => {
      const r = origGetRenderer(layer);
      if (r && !r._pvPatched) {
        r._pvPatched = true;
        const orig = r._update.bind(r);
        r._update = () => {
          this._raw = true;
          try { orig(); } finally { this._raw = false; }
        };
        if (this._active) r._update();
      }
      return r;
    };

    // Dra kartan: Leaflet lägger fingrets skärmvektor rakt på kartrutans
    // position. Rutan är roterad, så vektorn måste roteras tillbaka först —
    // annars glider kartan snett i förhållande till fingret. Tröghetsutkastet
    // efter släpp räknas på samma (nu tillbakaroterade) värden och blir rätt
    // på köpet.
    const dr = map.dragging?._draggable;
    if (dr) {
      const orig = dr._updatePosition.bind(dr);
      dr._updatePosition = () => {
        if (this._active) {
          const off = dr._newPos.subtract(dr._startPos);
          dr._newPos = dr._startPos.add(turn(off, -this.cssAngle));
        }
        orig();
      };
    }
  }

  /* ================= Storlek ================= */

  #observeSize() {
    const update = () => {
      this.view = { w: this.outer.clientWidth || 1, h: this.outer.clientHeight || 1 };
      if (this._over) { this._over = false; this.#oversize(true); }
    };
    if ('ResizeObserver' in window) {
      let pending = 0;
      this._ro = new ResizeObserver(() => {
        cancelAnimationFrame(pending);
        pending = requestAnimationFrame(update);
      });
      this._ro.observe(this.outer);
    } else {
      addEventListener('resize', update);
    }
  }

  /** Kalla när vyn blivit synlig igen — #map kan ha haft storlek 0. */
  refresh() {
    this.view = { w: this.outer.clientWidth || 1, h: this.outer.clientHeight || 1 };
    if (this._over) { this._over = false; this.#oversize(true); }
  }

  /**
   * Förstora Leafletbehållaren till en kvadrat som täcker skärmen i alla
   * vridningar. Görs bara när kartan faktiskt är vriden — den som kör med norr
   * uppåt ska inte betala för brickor hen aldrig ser.
   */
  #oversize(on) {
    if (on === this._over) return;
    this._over = on;
    const c = this.container;

    if (on) {
      const { w, h } = this.view;
      const diag = Math.hypot(w, h);
      const padX = Math.ceil((diag - w) / 2);
      const padY = Math.ceil((diag - h) / 2);
      this._pad = { x: padX, y: padY };
      c.style.left = -padX + 'px';
      c.style.top = -padY + 'px';
      c.style.width = (w + padX * 2) + 'px';
      c.style.height = (h + padY * 2) + 'px';
    } else {
      this._pad = { x: 0, y: 0 };
      c.style.left = '0px';
      c.style.top = '0px';
      c.style.width = '100%';
      c.style.height = '100%';
    }

    // Kontrollerna sitter i behållarens hörn. Flytta in dem så de hamnar i den
    // SYNLIGA rutans hörn i stället för utanför skärmkanten.
    const cc = c.querySelector('.leaflet-control-container');
    if (cc) {
      cc.style.position = 'absolute';
      cc.style.left = this._pad.x + 'px';
      cc.style.right = this._pad.x + 'px';
      cc.style.top = this._pad.y + 'px';
      cc.style.bottom = this._pad.y + 'px';
    }

    if (this.tileLayer) this.tileLayer.options.keepBuffer = on ? 1 : 2;

    // Symmetrisk förstoring → invalidateSize håller kvar samma mittpunkt.
    this.map.invalidateSize({ pan: true, animate: false });
  }

  /* ================= Rotationen ================= */

  #setActive(on) {
    if (on === this._active) return;
    this._active = on;
    if (on) {
      this.#oversize(true);
      this.host.classList.add('pv-rotated');
      this.map.options.touchZoom = 'center';
      // Öppna popup-bubblor räknar sin autopanorering i oroterad rymd. Stäng
      // den som råkar vara öppen, och stäng av autopanoreringen i övriga.
      this.map.closePopup();
      this.map.eachLayer(l => { const p = l.getPopup?.(); if (p) p.options.autoPan = false; });
    } else {
      this.host.classList.remove('pv-rotated');
      this.map.options.touchZoom = this._origTouchZoom;
      this.map.eachLayer(l => { const p = l.getPopup?.(); if (p) p.options.autoPan = true; });
      this.#oversize(false);
    }
    this.dispatchEvent(new CustomEvent('activechange', { detail: on }));
  }

  /** Sätt vinkeln direkt, utan mjukstart. Används under fingergesten. */
  setBearing(b) {
    this.bearing = norm360(b);
    this._target = this.bearing;
    this._animating = false;
    if (this.rotated) this.#setActive(true);
    this.#schedule();
  }

  #animateTo(target, tau) {
    this._target = norm360(target);
    this._tau = tau;
    if (Math.abs(norm180(this._target - this.bearing)) < 0.2) {
      this.bearing = this._target;
      this._animating = false;
      this.#schedule();
      return;
    }
    if (this.rotated || Math.abs(norm180(this._target)) > 0.5) this.#setActive(true);
    this._animating = true;
    this._lastTs = 0;
    this.rotor.classList.add('pv-anim');
    this.#schedule();
  }

  #schedule() {
    if (!this._raf) this._raf = requestAnimationFrame(this._frame);
  }

  _frame = ts => {
    this._raf = 0;
    if (this._animating) {
      const dt = this._lastTs ? Math.min(64, ts - this._lastTs) : 16;
      this._lastTs = ts;
      const d = norm180(this._target - this.bearing);
      if (Math.abs(d) < 0.2) { this.bearing = this._target; this._animating = false; }
      else this.bearing = norm360(this.bearing + d * (1 - Math.exp(-dt / this._tau)));
    }
    this.#paint();
    if (this._animating) this.#schedule();
    else this.#settle();
  };

  /**
   * En enda stilskrivning per bildruta, på en förfader. Rotorn läser
   * --pv-rot, allt som ska stå upprätt läser --pv-anti, kompassnålen läser
   * --pv-rot. Ingen loop över markörer, ingen ikon byggs om, ingen layout —
   * bara transform, som webbläsaren kan lägga på kompositorn.
   */
  #paint() {
    const rot = -this.bearing;
    const shown = Math.round(rot * 10) / 10;
    if (shown !== this._painted) {
      this._painted = shown;
      this.host.style.setProperty('--pv-rot', shown + 'deg');
    }
    // Markörernas motrotation behöver inte tiondels grad. En hel grad är
    // osynlig på en 38 px ikon och sparar en stilomräkning per bildruta.
    const anti = Math.round(this.bearing);
    if (anti !== this._anti) {
      this._anti = anti;
      this.host.style.setProperty('--pv-anti', anti + 'deg');
    }
    this.#syncUi();
  }

  /** Efter att rotationen stannat: släpp kompositorlagret och städa. */
  #settle() {
    clearTimeout(this._animTimer);
    this._animTimer = setTimeout(() => this.rotor.classList.remove('pv-anim'), 400);

    clearTimeout(this._settleTimer);
    if (!this.rotated && this.mode !== 'course' && this.mode !== 'manual') {
      this._settleTimer = setTimeout(() => {
        if (!this.rotated && this.mode === 'north' && !this._animating) this.#setActive(false);
      }, 600);
    }
    this.dispatchEvent(new CustomEvent('bearingchange', { detail: this.bearing }));
  }

  #setMode(m) {
    if (m === this.mode) return;
    this.mode = m;
    this.#syncUi();
    this.dispatchEvent(new CustomEvent('modechange', { detail: m }));
  }

  /* ================= Kommandon ================= */

  /** Kompassknappen: tillbaka till norr uppåt. */
  north() {
    // Trycket betyder "jag vill se norr nu". Kör-upp pausas därför tills bilen
    // faktiskt stått still en stund — annars hade kartan snurrat tillbaka inom
    // en sekund och knappen varit meningslös.
    this._paused = true;
    this.#setMode('north');
    this.#animateTo(0, TAU_NORTH_MS);
    this.#hint('Norr uppåt.', 1800);
  }

  /** Långt tryck: stäng av eller slå på kör-upp helt. */
  toggleCourseUp() {
    this.courseUp = !this.courseUp;
    save({ ...load(), courseUp: this.courseUp });
    this._paused = false;
    this.#setMode('north');
    if (this.courseUp) {
      this.#hint('Kör-upp på. Kartan vrids så färdriktningen är uppåt när du kör.');
    } else {
      this.#animateTo(0, TAU_NORTH_MS);
      this.#hint('Kör-upp av. Vrid kartan med två fingrar och håll in kompassen för att slå på igen.', 5000);
    }
  }

  /**
   * Varje GPS-fix. Enda kurskällan är den appen redan räknar fram i geo.js —
   * ingen kompass, inget andra spår som kan säga emot.
   */
  updateFromFix(fix) {
    const kmh = fix?.speedKmh ?? 0;
    const now = Date.now();

    if (kmh < STOP_KMH) { if (!this._stillSince) this._stillSince = now; }
    else this._stillSince = 0;

    // Bilen har stått still en minut: nästa igångkörning är en ny körning, och
    // då får kör-upp komma tillbaka av sig självt.
    if (this._paused && this._stillSince && now - this._stillSince > STOP_RESUME_MS) {
      this._paused = false;
    }

    if (!this.courseUp || this._paused) return;
    // Manuellt vriden karta rör vi inte. Föraren har sagt vad hen vill se, och
    // tar sig ur det med kompassknappen.
    if (this.mode === 'manual') return;

    const h = fix?.headingSmoothed;
    if (!Number.isFinite(h)) return;

    // I rödljus, i kö och på parkeringen är GPS-kursen ren gissning. Under
    // gränsen fryser vi senaste riktningen i stället för att låta kartan
    // snurra. Det här är skillnaden mellan en karta man kan titta på och en
    // karta som gör en åksjuk.
    if (kmh < COURSE_MIN_KMH) return;
    if (fix.accuracy != null && fix.accuracy > 60) return;

    if (this.mode !== 'course') this.#setMode('course');
    if (Math.abs(norm180(h - this._target)) < COURSE_DEADBAND_DEG) return;
    this.#animateTo(h, TAU_COURSE_MS);
  }

  /**
   * I kör-upp ska bilen ligga en bit ner på skärmen, som i Waze — det man
   * behöver se är vägen framåt, inte den man just kört. Räknar om vilken
   * mittpunkt kartan ska ha för att bilen ska hamna där.
   * Returnerar null när ingen förskjutning ska ske.
   */
  followTarget(lat, lon) {
    if (this.mode !== 'course' || !this._active) return null;
    const d = Math.round(this.view.h * LOOKAHEAD);
    if (!d) return null;
    const z = this.map.getZoom();
    const b = this.bearing * Math.PI / 180;
    // Skärmens "nedåt" uttryckt i lagerkoordinater.
    const off = L.point(-d * Math.sin(b), d * Math.cos(b));
    try {
      return this.map.unproject(this.map.project([lat, lon], z).subtract(off), z);
    } catch { return null; }
  }

  /* ================= Gesten ================= */

  #wireGesture() {
    const c = this.container;
    let live = false, engaged = false, prev = 0, acc = 0, baseBearing = 0;

    const angle = (a, b) =>
      Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) * 180 / Math.PI;

    // Passiva lyssnare, inget preventDefault: Leaflets egen nypzoom och
    // panorering ska fortsätta fungera exakt som förut. Vi läser bara samma
    // fingrar en gång till och lägger vridningen ovanpå.
    c.addEventListener('touchstart', e => {
      if (e.touches.length !== 2) { live = false; return; }
      live = true;
      engaged = false;
      acc = 0;
      prev = angle(e.touches[0], e.touches[1]);
      baseBearing = this.bearing;
    }, { passive: true });

    c.addEventListener('touchmove', e => {
      if (!live || e.touches.length !== 2) return;
      const cur = angle(e.touches[0], e.touches[1]);
      const inc = norm180(cur - prev);
      prev = cur;
      acc += inc;

      // Tröskeln finns för att en vanlig nypzoom alltid vrider sig några
      // grader på vägen. Under tröskeln händer ingenting alls; över den tar
      // rotationen vid utan hopp, eftersom vi nollställer mot nuläget.
      if (!engaged) {
        if (Math.abs(acc) < TWIST_START_DEG) return;
        engaged = true;
        acc = 0;
        baseBearing = this.bearing;
        this.#setMode('manual');
        this.#setActive(true);
        this.rotor.classList.add('pv-anim');
        return;
      }
      this.setBearing(baseBearing - acc);
    }, { passive: true });

    const end = e => {
      if (e.touches.length >= 2) return;
      if (live && engaged && Math.abs(norm180(this.bearing)) < SNAP_DEG) {
        // Nästan norr när fingrarna släpper — snäpp dit. Ingen vill ha en
        // karta som ligger tre grader snett.
        this.#setMode('north');
        this._paused = true;
        this.#animateTo(0, TAU_NORTH_MS);
      }
      live = false;
      engaged = false;
    };
    c.addEventListener('touchend', end, { passive: true });
    c.addEventListener('touchcancel', end, { passive: true });
  }
}

const CSS = `
@property --pv-anti { syntax: '<angle>'; inherits: true; initial-value: 0deg; }

.pv-map-clip { overflow: hidden; }
.pv-map { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }

.pv-rotor { position: absolute; left: 0; top: 0; width: 100%; height: 100%; transform-origin: 50% 50%; }
.pv-rotated .pv-rotor { transform: rotate(var(--pv-rot, 0deg)); }
.pv-rotor.pv-anim { will-change: transform; }

/* Allt som ritas på kartan står upprätt. Motrotationen är en nedärvd variabel,
   så en enda skrivning uppdaterar samtliga markörer. */
.pv-rotated .pv-upright { display: inline-block; transform: rotate(var(--pv-anti, 0deg)); transform-origin: 50% 50%; }
.pv-rotated .pv-upright-pin { transform-origin: 50% 92%; }

/* Sömmarna mellan brickorna: en pixels överlapp döljer subpixelavrundningen. */
.pv-rotated .leaflet-tile { width: var(--pv-tile, 257px) !important; height: var(--pv-tile, 257px) !important; }

/* Bubblan och dess spets vrids kring samma punkt — bubblans nederkant är
   spetsens överkant — så hela popupen vrids stelt kring sin ankarpunkt. */
.pv-rotated .leaflet-popup-content-wrapper { transform: rotate(var(--pv-anti, 0deg)); transform-origin: 50% 100%; }
.pv-rotated .leaflet-popup-tip-container { transform: rotate(var(--pv-anti, 0deg)); transform-origin: 50% 0; }
/* Stängkrysset sitter absolut i popupens oroterade hörn och följer inte med.
   Tryck på kartan stänger ändå bubblan. */
.pv-rotated .leaflet-popup-close-button { display: none; }

.pv-compass {
  position: absolute; z-index: 500; right: 12px;
  bottom: calc(var(--act-h, 76px) + 34vh + 56px);
  width: 46px; height: 46px; border-radius: 50%;
  background: rgba(11,15,20,.86); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  border: 1px solid var(--line, #26323f); color: var(--fg, #eef4fa);
  display: grid; place-items: center;
  box-shadow: 0 6px 18px rgba(0,0,0,.45);
  opacity: 0; transform: scale(.7); pointer-events: none;
  transition: opacity .18s ease, transform .18s ease;
  touch-action: manipulation;
}
.pv-compass.show { opacity: 1; transform: none; pointer-events: auto; }
.pv-compass.course { border-color: var(--accent, #3d9dff); box-shadow: 0 0 0 1px rgba(61,157,255,.35), 0 6px 18px rgba(0,0,0,.45); }
.pv-compass:active { transform: scale(.93); }
.pv-compass svg { width: 28px; height: 28px; transform: rotate(var(--pv-rot, 0deg)); }

.pv-hint {
  position: absolute; z-index: 500; right: 12px;
  bottom: calc(var(--act-h, 76px) + 34vh + 110px);
  max-width: 62vw; padding: 7px 11px;
  background: rgba(11,15,20,.92); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  border: 1px solid var(--line, #26323f); border-radius: 11px;
  font-size: 12.5px; line-height: 1.35; color: var(--fg, #eef4fa);
  opacity: 0; pointer-events: none; transition: opacity .2s ease;
}
.pv-hint.show { opacity: 1; }

@media (prefers-reduced-motion: reduce) {
  .pv-compass { transition: none; }
}
`;
