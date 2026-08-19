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

const TILES = {
  day: {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    // Kartbrickor från CARTO, kartdata från OpenStreetMap, ruttberäkning från
    // OSRM och adressökning från Nominatim. Alla fyra är gratis att använda
    // och alla fyra kräver att man skriver vem de kommer ifrån. Vi använde
    // OSRM och Nominatim utan att nämna dem — det är inte en detalj, det är
    // villkoret för att få fortsätta använda dem.
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, ' +
      '&copy; <a href="https://carto.com/attributions">CARTO</a> · ' +
      'Rutter: <a href="http://project-osrm.org/">OSRM</a> · ' +
      'Sök: <a href="https://nominatim.openstreetmap.org/">Nominatim</a>',
  },
  night: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    // Kartbrickor från CARTO, kartdata från OpenStreetMap, ruttberäkning från
    // OSRM och adressökning från Nominatim. Alla fyra är gratis att använda
    // och alla fyra kräver att man skriver vem de kommer ifrån. Vi använde
    // OSRM och Nominatim utan att nämna dem — det är inte en detalj, det är
    // villkoret för att få fortsätta använda dem.
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, ' +
      '&copy; <a href="https://carto.com/attributions">CARTO</a> · ' +
      'Rutter: <a href="http://project-osrm.org/">OSRM</a> · ' +
      'Sök: <a href="https://nominatim.openstreetmap.org/">Nominatim</a>',
  },
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
      attribution: TILES.night.attribution, maxZoom: 19, subdomains: 'abcd',
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

    this.markers = new Map();
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
  render(hazards, myPos) {
    const seen = new Set();
    for (const h of hazards) {
      seen.add(h.id);
      const pos = [h.lat, h.lon];
      let m = this.markers.get(h.id);
      if (!m) {
        m = L.marker(pos, { icon: this.#hazardIcon(h) }).addTo(this.map);
        m.on('click', () => this.dispatchEvent(new CustomEvent('hazardclick', { detail: h })));
        this.markers.set(h.id, m);
      } else {
        m.setLatLng(pos);
        m.setIcon(this.#hazardIcon(h));
      }
      const dist = myPos
        ? `<br><span class="pop-dist">${shortDistance(
            Math.hypot((h.lat - myPos.lat) * 111320, (h.lon - myPos.lon) * 111320 * Math.cos(h.lat * Math.PI / 180))
          )} bort</span>` : '';
      const age = h.createdAt ? `<br><span class="pop-age">${relativeTime(h.createdAt)}</span>` : '';
      m.bindPopup(
        `<b>${TYPE_ICON[h.type] || '⚠️'} ${TYPE_LABEL[h.type] || 'Varning'}</b>` +
        (h.label ? `<br>${escapeHtml(h.label)}` : '') + dist + age +
        (h.source === 'facebook' ? '<br><span class="pop-src">Från Facebook-gruppen</span>' : ''),
        this.#popupOpts()
      );
    }
    for (const [id, m] of this.markers) {
      if (!seen.has(id)) { this.map.removeLayer(m); this.markers.delete(id); }
    }
  }

  /**
   * En 40 minuter gammal polisrapport är oftast skräp. Låt kartan visa det
   * utan att föraren behöver läsa en tidsangivelse: färsk rapport pulserar,
   * gammal bleknar. Kartan sanerar sig själv visuellt.
   */
  #hazardIcon(h) {
    const cls = [`hazard-icon`, `type-${h.type}`];
    let opacity = 1;

    if (!h.fixed && h.createdAt) {
      const ageMin = (Date.now() - h.createdAt) / 60000;
      const lifeMin = h.expiresAt ? (h.expiresAt - h.createdAt) / 60000 : 45;
      const left = 1 - Math.min(1, ageMin / lifeMin);

      if (ageMin < 5) cls.push('fresh');
      else if (left < 0.25) cls.push('stale');
      // Blekna från full styrka ner till 40 % under livslängden
      opacity = 0.4 + 0.6 * left;
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
