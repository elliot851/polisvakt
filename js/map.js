// Kartan. Leaflet + OpenStreetMap-brickor, inga API-nycklar.
//
// Rotationen (tvåfingersvridning och kör-upp) bor i kartrotation.js. Den
// behöver komma åt Leaflets insida på ett sätt som inte hör hemma här, och
// den är den enda delen av kartan som har egna DOM-element och egen CSS.
// Se docs/KARTA.md för varför den ser ut som den gör.

import { TYPE_ICON, TYPE_LABEL } from './parser.js';
import { shortDistance, relativeTime } from './util.js';
import { VASTERAS } from './geocode.js';
import { MapRotation } from './kartrotation.js';
import { sammanfattaLang } from './sammanfattning.js';
import { isMine, TTL_MINUTES } from './store.js';

/**
 * Hur länge nålen ska tona ut, i minuter.
 *
 * TROVÄRDIGHETSTIDEN (TTL_MINUTES), inte visningstiden. Uttoningen räknades
 * förut ur expiresAt − createdAt, vilket var samma sak så länge de två talen
 * var samma tal. Sedan visningstiden blev fyra timmar (store.js
 * VISNING_MINUTER) är de det inte: hade uttoningen följt expiresAt skulle en
 * polisnål stå på 84 % styrka efter 45 minuter och bli "stale" först efter
 * tre timmar. Då hade den längre livslängden gjort kartan MER påstridig om
 * gamla uppgifter, vilket var precis vad som skulle undvikas.
 *
 * Nålen bleknar alltså i takt med att appen slutar tro på rapporten, och
 * ligger sedan kvar blek tills visningstiden går ut.
 */
function trovardighetMin(h) {
  return TTL_MINUTES[h.type] ?? 45;
}

// KARTBRICKORNA — nyckelfria (Esri Canvas).
//
// Låg tidigare på CARTO (basemaps.cartocdn.com). CARTO kräver sedan 2024/2025
// en API-nyckel för sina basemaps, och utan den svarar de "API key required" —
// kartan blev då bara en tom, grå ruta. Bytt till Esris Canvas-brickor som
// fungerar utan nyckel: World_Dark_Gray_Base (natt) och World_Light_Gray_Base
// (dag). Rena, dämpade kartor som passar en varningskarta man kastar en blick
// på i bilen.
//
// OBS ordningen: Esri är {z}/{y}/{x} (inte {z}/{x}/{y} som CARTO), och det
// finns inget @2x/{r} och inga {s}-subdomäner — en enda värd. maxNativeZoom
// är 16 (Esri Canvas ritar inte längre in), men maxZoom får vara 19 så Leaflet
// skalar upp sista stegen i stället för att visa tomt.
//
// INFÖR LANSERING: vill man ha CARTO:s snyggare mörka kartografi igen skaffar
// man en CARTO-nyckel (gratis upp till ~75k brickor/mån) och lägger URL:en med
// ?api_key=... i en config-slot. Esri räcker gott för testfasen och kostar
// ingenting.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · ' +
  'Brickor: <a href="https://www.esri.com/">Esri</a> · ' +
  'Rutter: <a href="http://project-osrm.org/">OSRM</a> · ' +
  'Sök: <a href="https://nominatim.openstreetmap.org/">Nominatim</a>';

const TILES = {
  day:   { url: ESRI + '/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', attribution: ATTR },
  night: { url: ESRI + '/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',  attribution: ATTR },
};

export class HazardMap extends EventTarget {
  constructor(el) {
    super();

    // Leaflet får inte hela #map, utan en egen ruta inuti. #map blir en
    // klippande ram. Kartan behöver kunna vara STÖRRE än den syns när den är
    // vriden — annars blir hörnen tomma — och då måste något klippa bort
    // överskottet. Se kartrotation.js.
    this.el = el;
    this.inner = document.createElement('div');
    this.inner.className = 'pv-map';
    el.appendChild(this.inner);

    this.map = L.map(this.inner, {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true,
      tap: true,
    }).setView([VASTERAS.lat, VASTERAS.lon], 13);

    this.theme = 'night';
    this.tileLayer = L.tileLayer(TILES.night.url, {
      // maxNativeZoom 16: Esri Canvas har inga brickor bortom det. maxZoom 19
      // behålls så inzoomningen känns likadan — Leaflet skalar upp 17–19.
      attribution: TILES.night.attribution, maxZoom: 19, maxNativeZoom: 16,
    }).addTo(this.map);

    L.control.zoom({ position: 'bottomleft' }).addTo(this.map);

    this.rotation = new MapRotation(this.map, {
      outer: el,
      container: this.inner,
      host: el.parentElement || el,
      tileLayer: this.tileLayer,
    });
    // Skicka vidare, så att resten av appen kan lyssna utan att känna till
    // rotationsmodulen.
    for (const ev of ['bearingchange', 'modechange']) {
      this.rotation.addEventListener(ev, e =>
        this.dispatchEvent(new CustomEvent(ev, { detail: e.detail })));
    }

    // Mät om så fort layouten satt sig.
    //
    // Leaflet läser containerns höjd EN gång, vid skapandet. Här skapas
    // kartan innan webbläsaren hunnit räkna färdigt på flexlayouten, så den
    // fick höjden noll och laddade en enda rad brickor — resten av skärmen
    // blev svart och förblev svart, eftersom ingenting någonsin bad den mäta
    // om. Kartan såg ut att ladda långsamt; i själva verket var den klar,
    // bara felmätt.
    //
    // ResizeObserver täcker även rotation av telefonen och att tangentbordet
    // fälls upp. Engångsmätningen efter två bildrutor finns kvar för
    // säkerhets skull: observern fyrar inte alltid på den allra första
    // layouten.
    requestAnimationFrame(() => requestAnimationFrame(() => this.map.invalidateSize()));
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this.map.invalidateSize());
      this._ro.observe(el);
    }

    // Nålarna ritas bara för det som är i bild, så kartan måste rita om när
    // man panorerat eller zoomat. moveend, inte move — att rita om under
    // fingret är precis det som gör en karta hackig.
    this.map.on('moveend zoomend', () => {
      clearTimeout(this._omritTimer);
      this._omritTimer = setTimeout(() => this.omrita(), 120);
    });

    this.markers = new Map();
    this.manoverMarkers = new Map();
    this.meMarker = null;
    this.accuracyCircle = null;
    this.follow = true;
    this.pickMode = false;

    // Slutar följa så fort användaren själv drar i kartan
    this.map.on('dragstart', () => {
      if (this.pickMode) return;
      this.follow = false;
      this.dispatchEvent(new CustomEvent('followchange', { detail: false }));
    });

    this.map.on('click', e => {
      if (!this.pickMode) return;
      this.dispatchEvent(new CustomEvent('pick', {
        detail: { lat: e.latlng.lat, lon: e.latlng.lng },
      }));
    });
  }

  setTheme(theme) {
    if (theme === this.theme) return;
    this.theme = theme;
    const t = TILES[theme] || TILES.night;
    this.tileLayer.setUrl(t.url);
    document.body.dataset.mapTheme = theme;
  }

  setPickMode(on) {
    this.pickMode = on;
    this.map.getContainer().style.cursor = on ? 'crosshair' : '';
  }

  setFollow(on) {
    this.follow = on;
    if (on && this._lastFix) this.centerOn(this._lastFix.lat, this._lastFix.lon);
    this.dispatchEvent(new CustomEvent('followchange', { detail: on }));
  }

  centerOn(lat, lon, zoom) {
    this.map.setView([lat, lon], zoom ?? Math.max(this.map.getZoom(), 15), { animate: true });
  }

  /* ---------- Rotation ---------- */

  /** Kompassriktningen som pekar uppåt på skärmen. 0 = norr uppåt. */
  get bearing() { return this.rotation.bearing; }
  get rotationMode() { return this.rotation.mode; }

  setBearing(deg) { this.rotation.setBearing(deg); }
  northUp() { this.rotation.north(); }
  setCourseUp(on) { if (this.rotation.courseUp !== !!on) this.rotation.toggleCourseUp(); }

  /** Uppdatera egen position. Pilen pekar i färdriktningen. */
  updateMe(fix) {
    this._lastFix = fix;
    const pos = [fix.lat, fix.lon];
    // Pilen roteras i kartans egen rymd. När kartan är vriden räknas
    // vridningen bort av sig själv, så pilen pekar rätt på skärmen utan att vi
    // gör något extra — i kör-upp pekar den alltid rakt upp, som den ska.
    const heading = fix.headingSmoothed ?? 0;

    if (!this.meMarker) {
      this.meMarker = L.marker(pos, {
        icon: this.#meIcon(heading),
        interactive: false,
        zIndexOffset: 1000,
      }).addTo(this.map);
      this.accuracyCircle = L.circle(pos, {
        radius: fix.accuracy || 20,
        color: '#4aa8ff', weight: 1, opacity: .35,
        fillColor: '#4aa8ff', fillOpacity: .1, interactive: false,
      }).addTo(this.map);
    } else {
      this.meMarker.setLatLng(pos);
      this.meMarker.setIcon(this.#meIcon(heading));
      this.accuracyCircle.setLatLng(pos).setRadius(fix.accuracy || 20);
    }

    // Kursen matas in här, från samma fix som allt annat. Ingen andra
    // kurskälla — två källor som säger olika saker är värre än en osäker.
    this.rotation.updateFromFix(fix);

    if (this.follow) {
      // I kör-upp ligger bilen en bit ner på skärmen så man ser vägen framåt.
      const target = this.rotation.followTarget(fix.lat, fix.lon);
      this.map.panTo(target || pos, { animate: true, duration: .5 });
    }
  }

  #meIcon(heading) {
    return L.divIcon({
      className: 'me-icon',
      html: `<div class="me-arrow" style="transform:rotate(${heading}deg)"></div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  }

  /** Synka markörer mot listan av faror. */
  /**
   * Så många nålar kartan får rita samtidigt.
   *
   * Ingen kan läsa av fler än så på en telefonskärm, och de kostar ordentligt:
   * varje nål är ett DOM-element som Leaflet flyttar vid varje panorering.
   * Måttet som fick den här gränsen att införas: hela kameradatan ritades ut
   * på en gång — 2 466 nålar och 5 755 DOM-noder på en sida som annars har
   * ett par hundra. Det var hela lagget.
   */
  static MAX_NALAR = 350;

  render(hazards, myPos) {
    // Sparas för att kunna rita om vid panorering utan att räkna om allt
    // uppströms.
    this._sistaHazards = hazards;
    this._sistaPos = myPos;

    // Bara det som är i bild, med marginal så nålar hinner finnas när man
    // drar. Kameror är fasta punkter över hela Sverige — resten av landet
    // behöver inte finnas i DOM:en medan du kör i Västerås.
    const vy = this.map.getBounds().pad(0.4);
    let synliga = hazards.filter(h => vy.contains([h.lat, h.lon]));

    // Zoomar man ut över hela landet ryms allt i bild igen. Då prioriteras
    // det som ligger närmast mitten av kartan — det man faktiskt tittar på.
    if (synliga.length > HazardMap.MAX_NALAR) {
      const c = this.map.getCenter();
      synliga = synliga
        .map(h => [h, (h.lat - c.lat) ** 2 + (h.lon - c.lng) ** 2])
        .sort((a, b) => a[1] - b[1])
        .slice(0, HazardMap.MAX_NALAR)
        .map(p => p[0]);
    }

    const seen = new Set();
    for (const h of synliga) {
      seen.add(h.id);
      const pos = [h.lat, h.lon];
      let m = this.markers.get(h.id);
      if (!m) {
        m = L.marker(pos, { icon: this.#hazardIcon(h) }).addTo(this.map);
        m._pvSign = this.#ikonSignatur(h);
        m.on('click', () => this.dispatchEvent(new CustomEvent('hazardclick', { detail: m._pv })));
        // Innehållet byggs först när någon öppnar bubblan. Att bygga 2 466
        // popup-strängar vid varje omritning var en stor del av kostnaden,
        // och nästan ingen av dem öppnades någonsin.
        m.bindPopup(() => this.#popupInnehall(m._pv, this._sistaPos), this.#popupOpts());
        this.markers.set(h.id, m);
      } else {
        m.setLatLng(pos);
        // Ikonen byggs bara om när den faktiskt ändrat utseende. En fast
        // fartkamera ser likadan ut för alltid.
        const sign = this.#ikonSignatur(h);
        if (sign !== m._pvSign) { m.setIcon(this.#hazardIcon(h)); m._pvSign = sign; }
      }
      m._pv = h;
    }
    for (const [id, m] of this.markers) {
      if (!seen.has(id)) { this.map.removeLayer(m); this.markers.delete(id); }
    }
  }

  /* ---- Ruttlinjen -------------------------------------------------------
   *
   * Två linjer ovanpå varandra: en mörk under och en blå över. En ensam blå
   * linje försvinner rakt in i motorvägarnas gula och de gröna fälten på
   * kartan — den mörka kanten är det som gör den läsbar i en bil, i solsken,
   * i ögonvrån.
   *
   * Linjerna hamnar i Leaflets overlayPane, alltså UNDER farornålarna. Det är
   * rätt ordning: rutten är bakgrund, en polis framför dig är inte det.
   */
  ritaRutt(rutt, delad = null) {
    if (!rutt?.punkter?.length) { this.rensaRutt(); return; }

    const kvar = delad?.kvar?.length ? delad.kvar : rutt.punkter;
    const passerad = delad?.passerad?.length ? delad.passerad : [];

    if (!this._ruttLager) {
      this._ruttLager = {
        kant:     L.polyline([], { color: '#06121f', weight: 12, opacity: .9, lineJoin: 'round' }).addTo(this.map),
        passerad: L.polyline([], { color: '#5b6b7d', weight: 7, opacity: .55, lineJoin: 'round' }).addTo(this.map),
        kvar:     L.polyline([], { color: '#3d9bff', weight: 7, opacity: .95, lineJoin: 'round' }).addTo(this.map),
      };
    }
    this._ruttLager.kant.setLatLngs(rutt.punkter);
    this._ruttLager.passerad.setLatLngs(passerad);
    this._ruttLager.kvar.setLatLngs(kvar);

    // Svängpilarna. pv-upright motroterar symbolen när kartan är vriden —
    // utan den ligger pilarna på sidan så fort man kör åt något annat håll
    // än norrut, och en pil som pekar fel är värre än ingen pil.
    const vill = new Set();
    for (const m of rutt.manovrar || []) {
      if (!m.punkt || !m.symbol) continue;
      vill.add(m.index);
      let mk = this.manoverMarkers.get(m.index);
      if (!mk) {
        mk = L.marker(m.punkt, {
          icon: L.divIcon({
            className: 'manover-ikon',
            html: `<span class="pv-upright">${m.symbol}</span>`,
            iconSize: [26, 26], iconAnchor: [13, 13],
          }),
          interactive: false,
        }).addTo(this.map);
        this.manoverMarkers.set(m.index, mk);
      } else {
        mk.setLatLng(m.punkt);
      }
    }
    for (const [i, mk] of this.manoverMarkers) {
      if (!vill.has(i)) { this.map.removeLayer(mk); this.manoverMarkers.delete(i); }
    }
  }

  rensaRutt() {
    if (this._ruttLager) {
      for (const l of Object.values(this._ruttLager)) this.map.removeLayer(l);
      this._ruttLager = null;
    }
    for (const mk of this.manoverMarkers.values()) this.map.removeLayer(mk);
    this.manoverMarkers.clear();
  }

  /** Zooma så hela rutten syns. Används en gång, när rutten precis lagts in. */
  visaHelaRutten(rutt) {
    if (!rutt?.punkter?.length) return;
    try {
      this.map.fitBounds(L.latLngBounds(rutt.punkter), { padding: [40, 40], maxZoom: 15 });
    } catch {}
  }

  /** Ritar om med senast kända lista. Används när kartan panorerats. */
  omrita() {
    if (this._sistaHazards) this.render(this._sistaHazards, this._sistaPos);
  }

  /**
   * Allt som påverkar hur nålen ser ut, som en sträng. Skiljer sig den inte
   * från förra gången behöver ikonen inte byggas om.
   */
  #ikonSignatur(h) {
    if (h.fixed || !h.createdAt) return `${h.type}|fast`;
    const ageMin = (Date.now() - h.createdAt) / 60000;
    // Samma skala som #hazardIcon, annars slutar nålen ritas om mitt i
    // uttoningen. Den kopplingen är lätt att missa: signaturen är inte en
    // cachenyckel bredvid utseendet, den ÄR utseendet uttryckt som text.
    return `${h.type}|${Math.round(Math.min(1, ageMin / trovardighetMin(h)) * 10)}`;
  }

  /**
   * Innehållet i bubblan när någon tryckt på en nål.
   *
   * Här får den långa sammanfattningen plats, och här hör den hemma: ett
   * tryck på en nål är någon som vill veta vad rapporten BETYDER, inte se
   * samma fyra fakta en gång till i en ruta.
   *
   * Etiketten, tiden och källraden är borta ur bubblan — inte bortglömda,
   * utan uppslukade av meningen, som säger allihop i ett svep och dessutom
   * säger hur säkra de är. Ikonen och etiketten på själva nålen är orörda;
   * de är det man ser utan att trycka.
   *
   * Sammanfattningen vägrar beskriva en nykterhets- eller drogkontroll och
   * lämnar då tom sträng. Då faller bubblan tillbaka på den gamla
   * uppställningen i stället för att bli tom — en nål utan innehåll ser ut
   * som en trasig app, och rapporten borde ändå aldrig ha nått kartan.
   */
  #popupInnehall(h, myPos) {
    if (!h) return '';
    const avstand = myPos
      ? `<span class="pop-dist">${shortDistance(
          Math.hypot((h.lat - myPos.lat) * 111320, (h.lon - myPos.lon) * 111320 * Math.cos(h.lat * Math.PI / 180))
        )} bort</span>` : '';
    const dist = avstand ? `<br>${avstand}` : '';
    const rubrik = `<b>${TYPE_ICON[h.type] || '⚠️'} ${TYPE_LABEL[h.type] || 'Varning'}</b>`;

    let egen = false;
    try { egen = isMine(h.id); } catch {}
    const mening = sammanfattaLang(h, { egen });
    if (mening) {
      // Ingen <br> före avståndet här: div:en runt meningen bryter redan
      // raden, och två radbrytningar i rad ger ett tomrum mitt i bubblan.
      return rubrik + `<div class="pop-sum">${escapeHtml(mening)}</div>` + avstand;
    }

    const age = h.createdAt ? `<br><span class="pop-age">${relativeTime(h.createdAt)}</span>` : '';
    return rubrik +
      (h.label ? `<br>${escapeHtml(h.label)}` : '') + dist + age +
      (h.source === 'facebook' ? '<br><span class="pop-src">Från Facebook-gruppen</span>' : '');
  }

  /**
   * En 40 minuter gammal polisrapport är oftast skräp. Låt kartan visa det
   * utan att föraren behöver läsa en tidsangivelse: färsk rapport pulserar,
   * gammal bleknar. Kartan sanerar sig själv visuellt.
   *
   * Sedan rapporten ligger kvar i fyra timmar är det här inte längre en
   * finess utan bärande. Nålen tas inte bort när vi slutar tro på den — den
   * bleknar ner till ett golv och stannar där. Se trovardighetMin() ovan.
   */
  #hazardIcon(h) {
    const cls = [`hazard-icon`, `type-${h.type}`];
    let opacity = 1;

    if (!h.fixed && h.createdAt) {
      const ageMin = (Date.now() - h.createdAt) / 60000;
      const kvar = 1 - Math.min(1, ageMin / trovardighetMin(h));

      if (ageMin < 5) cls.push('fresh');
      else if (kvar < 0.25) cls.push('stale');
      // Blekna från full styrka ner till 40 % under trovärdighetstiden, och
      // ligg sedan kvar på 30 % resten av visningstiden. Golvet är lägre än
      // slutet på uttoningen med flit: skillnaden mellan "nästan slut" och
      // "har passerat" ska synas utan att nålen försvinner.
      opacity = kvar > 0 ? 0.4 + 0.6 * kvar : 0.3;
    }

    // pv-upright: symbolen motroteras när kartan är vriden. Ringen runt den är
    // rund och bryr sig inte, men en upp-och-nedvänd polisbil är obrukbar.
    return L.divIcon({
      className: cls.join(' '),
      html: `<span class="pv-upright" style="opacity:${opacity.toFixed(2)}">${TYPE_ICON[h.type] || '⚠️'}</span>`,
      iconSize: [38, 38],
      iconAnchor: [19, 19],
    });
  }

  /**
   * Leaflets autopanorering räknar i oroterade pixlar och drar kartan åt fel
   * håll när den är vriden — dessutom mot den dolda ytan utanför skärmen.
   * Stäng av den så länge kartan är vriden.
   */
  #popupOpts() {
    return { autoPan: !this.rotation.active };
  }

  /** Historiska hotspots som en diskret bakgrund under de aktiva rapporterna. */
  renderHotspots(spots) {
    if (this._hotLayer) this.map.removeLayer(this._hotLayer);
    if (!spots?.length) { this._hotLayer = null; return; }

    this._hotLayer = L.layerGroup(spots.map(s => {
      const weight = Math.min(1, s.count / 12);
      return L.circle([s.lat, s.lon], {
        radius: 160 + weight * 140,
        color: '#ff8a3d', weight: 1, opacity: 0.25 + weight * 0.25,
        fillColor: '#ff8a3d', fillOpacity: 0.06 + weight * 0.12,
        interactive: true,
      }).bindPopup(`<b>Återkommande plats</b><br>${escapeHtml(s.spoken)}<br>` +
        `<span class="pop-age">${s.count} rapporter i historiken</span>`, this.#popupOpts());
    })).addTo(this.map);

    this._hotLayer.eachLayer(l => l.bringToBack?.());
  }

  clearHotspots() {
    if (this._hotLayer) { this.map.removeLayer(this._hotLayer); this._hotLayer = null; }
  }

  /** Tillfällig markör när man pekar ut en plats. */
  showPin(lat, lon) {
    this.clearPin();
    this._pin = L.marker([lat, lon], {
      // Nålen vrids kring sin egen spets, så den pekar på samma punkt oavsett
      // hur kartan ligger.
      icon: L.divIcon({
        className: 'pick-pin',
        html: '<span class="pv-upright pv-upright-pin">📍</span>',
        iconSize: [30, 30], iconAnchor: [15, 28],
      }),
    }).addTo(this.map);
  }

  clearPin() {
    if (this._pin) { this.map.removeLayer(this._pin); this._pin = null; }
  }

  invalidate() {
    setTimeout(() => {
      // Ordningen spelar roll: rotationen räknar om sin förstoring utifrån
      // #map:s nya storlek och kallar invalidateSize själv när den behöver.
      this.rotation.refresh();
      this.map.invalidateSize();
    }, 60);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
