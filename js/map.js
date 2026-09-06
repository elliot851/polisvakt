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

/**
 * En helt genomskinlig 1×1-gif. En bricka som inte gick att hämta visar den i
 * stället för webbläsarens trasig-bild-ikon — och därmed det som ligger under,
 * vilket sedan bottenlagret finns alltid är karta.
 */
const TOM_BRICKA =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * Finaste zoomnivå bottenlagret hämtar. 9 är vald med flit: en enda z9-bricka
 * täcker ungefär 80 km, så vid körzoom (15–17) räcker en handfull brickor för
 * hela skärmen och de ligger kvar mil efter mil. Sätter man den högre blir
 * bottenlagret ett andra fullstort brickskikt och dubblar nättrafiken; sätter
 * man den lägre blir den uppskalade bilden så grov att den ser trasig ut.
 */
const BOTTEN_ZOOM = 9;

/**
 * Hur många brickrader utanför bild som får ligga kvar i minnet.
 * 4 är avvägningen mellan "brickan finns redan när du drar dit" och DOM-vikt.
 */
const BUFFERT = 4;

// ── FÖLJNINGEN ───────────────────────────────────────────────────────────────
//
// GPS ger en position i sekunden. Kartan ritar 60 bilder i sekunden. Skillnaden
// däremellan är hela skillnaden mellan en karta som hoppar och en karta som
// glider — och det är den ägaren menar med att Waze "känner av att du åker".
//
// Lösningen är inte att panorera oftare (det kostar en fullständig omritning
// per bildruta), utan att låta VARJE panorering vara lite längre än glappet
// mellan två fixar, köra den LINJÄRT, och sikta lite framför bilen. Då tar
// nästa panorering vid innan den förra hunnit stanna, och rörelsen blir
// obruten utan att kartan ritas om mer än en gång per fix.
const FOLJ_MIN_MS = 550;      // golv: en riktigt tät fixtakt ska inte ge ryck
const FOLJ_MAX_MS = 2200;     // tak: vid glesa fixar hellre lite lagg än frys
const FOLJ_MARGINAL = 1.25;   // animeringen görs 25 % längre än fixglappet
const FOLJ_MIN_KMH = 7;       // under detta räknas det som stillastående
/**
 * Hur stor del av animeringstiden kartan får sikta FRAMFÖR bilen.
 *
 * Utan framförhållning ligger kartan alltid ett halvt fixglapp efter, för den
 * börjar åka mot en punkt bilen redan lämnat. Med full framförhållning skjuter
 * den i stället över i varje kurva. 0,55 ligger där lagget är omärkligt och
 * översköjningen i en normal kurva är någon meter.
 */
const FRAMFORHALLNING = 0.55;
const FRAMFOR_MAX_M = 45;     // spärr mot en enstaka galen fartavläsning
/**
 * Hopp längre än så här många skärmdiagonaler animeras inte alls.
 * En GPS-teleportering (tunnel, kallstart, spoofad position) ska inte visas som
 * en tio sekunder lång glidning tvärs över Sverige.
 */
const HOPP_SKARMAR = 2.2;

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

      // ZOOMEN SKA GLIDA, INTE SNÄPPA.
      //
      // zoomSnap 0.25 låter nypzoomen landa mellan heltalsnivåerna. Med
      // standardvärdet 1 rycker kartan till närmaste hela nivå i samma sekund
      // som fingrarna släpper, och just det rycket är en stor del av varför
      // kartan känns billig jämfört med Waze.
      //
      // zoomDelta hålls kvar på 1: det styr +/−-knapparna och tangentbordet,
      // och en knapp som bara flyttar en fjärdedels nivå känns trasig.
      //
      // zoomAnimationThreshold höjs från 4 till 6. Leaflet vägrar animera
      // zoomhopp som är större än tröskeln och gör en hård omritning i stället.
      // centerOn() hoppar ofta tre–fyra nivåer (tryck på en nål i listan), och
      // det är just de hoppen som syns mest.
      zoomSnap: 0.25,
      zoomDelta: 1,
      wheelPxPerZoomLevel: 100,
      zoomAnimationThreshold: 6,

      // GOLV OCH TAK PÅ ZOOMEN.
      //
      // minZoom 4 är den halva av "bara fyrkanter"-problemet som inte går att
      // ladda bort. Utan golv kan man dra ut till z0–3 där jorden är några få
      // enorma brickor som droppar in en och en över en nästan tom skärm. Vid
      // z4 ryms hela Norden i bild och varje bildruta är full av karta. Appen
      // varnar för faror i Sverige — en världsvy har ingenting att visa.
      minZoom: 4,
      maxZoom: 19,

      // Tröghetsutkastet efter ett svep. Lägre inbromsning = längre glid, mer
      // som en fysisk yta man knuffat iväg än en ruta som stannar tvärt.
      inertiaDeceleration: 2600,
    }).setView([VASTERAS.lat, VASTERAS.lon], 13);

    // ── BOTTENLAGRET ────────────────────────────────────────────────────────
    //
    // Det här är svaret på "när jag zoomar ut är det bara fyrkanter".
    //
    // En bricka som inte hunnit laddas visar det som ligger UNDER den. Förut låg
    // det ingenting där, alltså behållarens bottenfärg — en grå/svart fyrkant.
    // Nu ligger ett andra brickskikt där som aldrig ritar finare än zoom 9 och
    // därför alltid är laddat: en enda z9-bricka täcker ~80 km, den hämtas en
    // gång och ligger kvar mil efter mil. Vid varje glapp i huvudlagret — snabb
    // utzoomning, hård panorering, dålig täckning, en bricka som svarar 404 —
    // ser man en grov karta i stället för ett hål.
    //
    // Kostnaden är nära noll: URL:en är densamma som huvudlagrets, så på zoom
    // 4–9 begär bottenlagret exakt de brickor huvudlagret redan begärt och
    // webbläsarens cache svarar direkt.
    //
    // Egen ruta (pane) med z-index 190, alltså under Leaflets tilePane (200).
    // pointerEvents av — lagret ska aldrig fånga ett tryck.
    this.map.createPane('pvBotten');
    const bottenRuta = this.map.getPane('pvBotten');
    bottenRuta.style.zIndex = '190';
    bottenRuta.style.pointerEvents = 'none';

    this.theme = 'night';
    // Skrivs redan här. css/karta.css läser attributet för att sätta kartans
    // bottenfärg, och den färgen behövs som mest vid uppstart — det är då flest
    // brickor saknas. Förut sattes attributet först vid ett TEMABYTE, och
    // eftersom nattläge är utgångsläget hann det aldrig sättas alls.
    document.body.dataset.mapTheme = this.theme;

    this.bottenLager = L.tileLayer(TILES.night.url, {
      pane: 'pvBotten',
      className: 'pv-botten',
      maxZoom: 19, maxNativeZoom: BOTTEN_ZOOM, minNativeZoom: 0,
      errorTileUrl: TOM_BRICKA,
      updateWhenIdle: false,
      updateWhenZooming: false,
      keepBuffer: BUFFERT,
      // Ingen attribution: samma källa som huvudlagret, och samma rad två
      // gånger i hörnet ser ut som en bugg.
    }).addTo(this.map);

    this.tileLayer = L.tileLayer(TILES.night.url, {
      // maxNativeZoom 16: Esri Canvas har inga brickor bortom det. maxZoom 19
      // behålls så inzoomningen känns likadan — Leaflet skalar upp 17–19.
      attribution: TILES.night.attribution, maxZoom: 19, maxNativeZoom: 16,
      minNativeZoom: 0,
      // Genomskinlig felbricka: en bricka som inte hann laddas visar
      // bottenlagret i stället för en grå fyrkant.
      errorTileUrl: TOM_BRICKA,

      // updateWhenIdle är Leaflets default TRUE på mobil — och det är den
      // enskilt värsta inställningen för en bilapp. Den betyder "ladda inga
      // nya brickor förrän kartan STÅR STILL". När man kör står kartan aldrig
      // still, så nya brickor började laddas först när man stannade. Det var
      // därför fyrkanterna följde med i färdriktningen.
      updateWhenIdle: false,
      // Men inte mitt i en zoomanimering: där hinner nivån ändå ändras igen
      // innan svaret kommer, och varje sådan hämtning är bortkastad. Med
      // bottenlagret under syns tomrummet ändå inte under själva animeringen.
      updateWhenZooming: false,
      keepBuffer: BUFFERT,
    }).addTo(this.map);
    // Basvärdet sparas på lagret: kartrotationen sänker bufferten medan
    // behållaren är förstorad och måste kunna lägga tillbaka rätt tal efteråt
    // i stället för att gissa.
    this.tileLayer._pvBasBuffert = BUFFERT;

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

    // Medan användaren nyper zoom ska följningen hålla tyst. En panorering
    // mitt i en zoomanimering anropar map._stop(), vilket kapar zoomen halvvägs
    // — kartan rycker till precis när fingrarna rör den. Samma sak gäller
    // omritningen av nålar: inget ska räknas om under fingret.
    this.map.on('zoomstart', () => {
      this._zoomar = true;
      this.#glidAv();
      clearTimeout(this._omritTimer);
    });
    this.map.on('zoomend', () => { this._zoomar = false; });

    // _resetView flyttar varenda markör på en gång, i samma bildruta. Glidningen
    // på egen-nålen måste vara avstängd då — annars ser det ut som att bilen
    // halkar iväg över kartan efter varje hård omritning.
    this.map.on('viewreset', () => this.#glidAv());

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
    const namn = theme in TILES ? theme : 'night';
    const t = TILES[namn];

    // Skrivs ALLTID, även när temat inte ändrats. css/karta.css läser attributet
    // för att sätta kartans bottenfärg, och den som anropar setTheme med samma
    // tema som redan gäller (vilket app.js gör vid varje temaomräkning) ska
    // ändå kunna lita på att attributet stämmer.
    document.body.dataset.mapTheme = namn;
    if (namn === this.theme) return;
    this.theme = namn;

    this.tileLayer.setUrl(t.url);

    // Bottenlagret byts FÖRST när huvudlagret har laddat om.
    //
    // setUrl tömmer lagret på samtliga brickor och laddar om från noll. Under de
    // tiondelarna är bottenlagret det enda som syns. Byttes båda samtidigt vore
    // hela skärmen tom vid varje skymning — alltså en vit eller svart blinkning
    // rakt i ansiktet på någon som kör. Nu ligger den gamla grova kartan kvar
    // tills den nya finns, och bytet blir en övertoning i stället för ett hål.
    //
    // Timern är säkerhetsnätet: 'load' fyras inte om varje bricka fallerar.
    clearTimeout(this._temaTimer);
    const byt = () => {
      clearTimeout(this._temaTimer);
      this.tileLayer.off('load', byt);
      if (this.bottenLager) this.bottenLager.setUrl(t.url);
    };
    this.tileLayer.once('load', byt);
    this._temaTimer = setTimeout(byt, 2000);
  }

  setPickMode(on) {
    this.pickMode = on;
    this.map.getContainer().style.cursor = on ? 'crosshair' : '';
  }

  setFollow(on) {
    this.follow = on;
    // Slutar vi följa ska egen-nålen inte längre glida mjukt: nästa gång den
    // flyttar sig är det för att GPS:en sa något nytt, inte för att kartan
    // åker med, och då ska den bara vara där.
    if (!on) this.#glidAv();
    if (on && this._lastFix) this.centerOn(this._lastFix.lat, this._lastFix.lon);
    this.dispatchEvent(new CustomEvent('followchange', { detail: on }));
  }

  /**
   * Flytta kartan till en punkt. Anropas när någon trycker på en nål, ett
   * sökträff eller på "följ mig igen".
   *
   * Låg förut på setView({animate:true}). Det ser mjukt ut i koden men är det
   * inte: Leaflet vägrar animera ett hopp som inte ryms inom skärmen, och
   * faller då tillbaka på en hård omritning. Ett tryck på en nål tio kilometer
   * bort blev alltså alltid ett hopp — kartan bytte plats utan att man såg vart
   * den tog vägen, och man tappade orienteringen.
   *
   * Nu skiljer vi på nära och långt. Nära: en kort panorering. Långt: flyTo,
   * som zoomar ut, glider dit och zoomar in igen i en enda båge. Den finns
   * inbyggd i Leaflet 1.9 — inget nytt beroende, ingen extern kod.
   */
  centerOn(lat, lon, zoom) {
    const mal = L.latLng(lat, lon);
    const nyZoom = zoom ?? Math.max(this.map.getZoom(), 15);
    this.#glidAv();

    const storlek = this.map.getSize();
    const diag = Math.hypot(storlek.x, storlek.y) || 1;
    let langt = true;
    try {
      const p = this.map.latLngToContainerPoint(mal);
      langt = Math.hypot(p.x - storlek.x / 2, p.y - storlek.y / 2) > diag * 0.6
           || Math.abs(nyZoom - this.map.getZoom()) > 1.5;
    } catch {}

    // Fönstret då följningen håller sig undan. Utan det kapar nästa GPS-fix
    // (som kommer inom en sekund) animeringen på mitten via map._stop(), och
    // resan dit blir ett ryck ändå.
    if (langt && typeof this.map.flyTo === 'function') {
      const sek = 1.1;
      this._flygerTill = Date.now() + sek * 1000;
      this.map.flyTo(mal, nyZoom, { duration: sek, easeLinearity: 0.3 });
    } else {
      this._flygerTill = Date.now() + 620;
      this.map.setView(mal, nyZoom, { animate: true, duration: 0.55, easeLinearity: 0.35 });
    }
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

    // Räknas EN gång per fix och används av både nålen och kartan, så att de
    // rör sig i exakt samma takt. Gör de inte det glider bilen i förhållande
    // till vägen, vilket är värre än att inget glider alls.
    const glidMs = this.#foljTakt(fix);

    if (!this.meMarker) {
      this.meMarker = L.marker(pos, {
        // Ikonen byggs EN gång. Se #riktaPil().
        icon: L.divIcon({
          className: 'me-icon',
          html: '<div class="me-arrow"></div>',
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        }),
        interactive: false,
        zIndexOffset: 1000,
      }).addTo(this.map);
      this._sistaNoggrannhet = fix.accuracy || 20;
      this.accuracyCircle = L.circle(pos, {
        radius: this._sistaNoggrannhet,
        color: '#4aa8ff', weight: 1, opacity: .35,
        fillColor: '#4aa8ff', fillOpacity: .1, interactive: false,
      }).addTo(this.map);
    } else {
      // Armera övergången INNAN positionen skrivs. Leaflet sätter en transform
      // på markörens element; med --pv-glid satt låter css/karta.css den
      // transformen tona över exakt lika länge som kartans egen panorering.
      // Ordningen spelar roll — sätts variabeln efteråt gäller den först nästa
      // gång, och nålen hoppar en sista gång per fix.
      if (this.follow && !this.pickMode) this.#glidPa(glidMs); else this.#glidAv();
      this.meMarker.setLatLng(pos);
      this.accuracyCircle.setLatLng(pos);
      // Radien ritar om HELA canvasytan, alltså även ruttlinjen och alla
      // hotspot-cirklar. Noggrannheten står oftast stilla mellan fixar, så gör
      // det bara när den faktiskt ändrat sig något att tala om.
      const r = fix.accuracy || 20;
      if (Math.abs(r - this._sistaNoggrannhet) > 2) {
        this.accuracyCircle.setRadius(r);
        this._sistaNoggrannhet = r;
      }
    }

    this.#riktaPil(heading);

    // Kursen matas in här, från samma fix som allt annat. Ingen andra
    // kurskälla — två källor som säger olika saker är värre än en osäker.
    this.rotation.updateFromFix(fix);

    if (this.follow && !this.pickMode && !this._zoomar) this.#foljMjukt(fix, glidMs);
  }

  /**
   * Hur lång nästa glidning ska vara, i millisekunder.
   *
   * Bygger på det UPPMÄTTA glappet mellan fixar i stället för ett antaget. En
   * telefon som ger position två gånger i sekunden och en som ger en var tredje
   * sekund ska båda se mjuka ut, och bara enheten själv vet vilken den är.
   *
   * Löpande medelvärde, inte senaste glappet: en enstaka sen fix (tunnel,
   * skärmen släcks en stund) ska inte göra nästa panorering dubbelt så lång och
   * kartan sirapig i tio sekunder efteråt.
   */
  #foljTakt(fix) {
    const nu = Number.isFinite(fix?.ts) ? fix.ts : Date.now();
    const ratt = Math.min(4000, Math.max(200, this._forraFixTs ? nu - this._forraFixTs : 1000));
    this._forraFixTs = nu;
    this._fixTakt = Number.isFinite(this._fixTakt) ? this._fixTakt * 0.7 + ratt * 0.3 : ratt;
    return Math.min(FOLJ_MAX_MS, Math.max(FOLJ_MIN_MS, this._fixTakt * FOLJ_MARGINAL));
  }

  /** Sätt/nollställ övergångstiden som css/karta.css använder på egen-nålen. */
  #glidPa(ms) { this.el.style.setProperty('--pv-glid', Math.round(ms) + 'ms'); }
  #glidAv()   { this.el.style.setProperty('--pv-glid', '0ms'); }

  /**
   * Vrid pilen utan att bygga om den.
   *
   * Förut anropades setIcon() vid VARJE fix. setIcon river markörens DOM-element
   * och skapar ett nytt — en gång i sekunden, för alltid. Ett element som byts
   * ut kan per definition inte tona någonstans; det poppar. Det gjorde också
   * varje CSS-övergång på .me-arrow omöjlig, och kostade en layout per fix mitt
   * i det enda ögonblick per sekund då kartan också panorerar.
   *
   * Nu finns pilen kvar och får bara en ny vinkel. isConnected-kontrollen är
   * för det fall Leaflet ändå byggt om markören (t.ex. om någon lägger till och
   * tar bort lagret) — då letas elementet upp på nytt i stället för att pilen
   * tyst slutar röra sig.
   */
  #riktaPil(deg) {
    if (!this._mePil || !this._mePil.isConnected) {
      this._mePil = this.meMarker?._icon?.querySelector?.('.me-arrow') || null;
      this._sistaKurs = null;
    }
    if (!this._mePil) return;
    const v = Math.round(deg);
    if (v === this._sistaKurs) return;
    this._sistaKurs = v;
    this._mePil.style.transform = `rotate(${v}deg)`;
  }

  /**
   * KARTAN SKA GLIDA MED BILEN, INTE HOPPA EFTER DEN.
   *
   * Det gamla anropet var panTo(pos, { animate: true, duration: .5 }) en gång
   * per GPS-fix. Tre saker var fel med det, och tillsammans är de hela
   * skillnaden mot Waze:
   *
   *  1. En halv sekunds animering på ett glapp som är en hel sekund betyder att
   *     kartan rör sig halva tiden och står still halva tiden. Ett halvt hopp,
   *     en gång i sekunden, för evigt.
   *
   *  2. Leaflets standardlättnad (easeLinearity .25) bromsar in i slutet av
   *     varje animering. En bil som håller jämn fart ska INTE bromsa in en gång
   *     i sekunden — den ska glida linjärt. Det här är den enskilt mest
   *     kännbara raden i filen.
   *
   *  3. Den siktade dit bilen VAR när fixen togs, alltså redan i det ögonblick
   *     animeringen började ett halvt fixglapp för långt bak. Kartan låg
   *     permanent efter och "kom ikapp" i ryck.
   *
   * Nu: animeringstiden är fixglappet plus marginal, så nästa panorering tar
   * vid innan den förra hunnit stanna; lättnaden är linjär medan man kör; och
   * målet ligger en bit framför bilen, räknat på dess egen fart och kurs.
   *
   * Detta slåss inte med användaren: 'dragstart' släcker this.follow innan
   * någon fix hinner emellan, och Leaflets dragghanterare kallar map._stop()
   * som avbryter vår animering i samma ögonblick fingret tar i kartan.
   */
  #foljMjukt(fix, glidMs) {
    // Håll händerna borta medan centerOn() flyger. Annars kapar den här
    // panoreringen den animeringen på mitten — se _flygerTill i centerOn().
    if (this._flygerTill && Date.now() < this._flygerTill) return;

    // 1. Sikta dit bilen är på väg.
    let lat = fix.lat, lon = fix.lon;
    const kmh = fix.speedKmh ?? 0;
    const kurs = fix.headingSmoothed;
    const kor = kmh >= FOLJ_MIN_KMH && Number.isFinite(kurs);
    if (kor) {
      const meter = Math.min(FRAMFOR_MAX_M, (kmh / 3.6) * (glidMs / 1000) * FRAMFORHALLNING);
      const r = kurs * Math.PI / 180;
      // En longitudgrad är kortare än en latitudgrad på våra breddgrader. Utan
      // cos(lat)-vikten skulle framförhållningen bli ~1,9 gånger för lång i
      // öst–västlig riktning och kartan skjuta över i varje sväng.
      const kx = Math.cos(fix.lat * Math.PI / 180) || 1;
      lat += (meter * Math.cos(r)) / 111320;
      lon += (meter * Math.sin(r)) / (111320 * kx);
    }

    // 2. I kör-upp ligger bilen en bit ner på skärmen så man ser vägen framåt.
    const mal = this.rotation.followTarget(lat, lon) || L.latLng(lat, lon);

    // 3. Är hoppet orimligt stort är det inte en bil som kört, det är GPS:en
    //    som bytt åsikt (tunnel, kallstart, spoofning). Då ska kartan bara vara
    //    på rätt plats, inte glida dit i tio sekunder.
    const storlek = this.map.getSize();
    const diag = Math.hypot(storlek.x, storlek.y) || 1;
    try {
      const p = this.map.latLngToContainerPoint(mal);
      const d = Math.hypot(p.x - storlek.x / 2, p.y - storlek.y / 2);
      // Under en pixel: rör inte kartan alls. Leaflet avrundar ändå bort det,
      // men anropet i sig river igång movestart/moveend och därmed omritningen.
      if (d < 1) return;
      if (d > diag * HOPP_SKARMAR) {
        this.map.setView(mal, this.map.getZoom(), { animate: false });
        return;
      }
    } catch {}

    // 4. easeLinearity 1 = helt linjärt. Vid stillastående får den däremot
    //    lätta ut: då är rörelsen GPS-brus, och brus som bromsar in ser mindre
    //    nervöst ut än brus som far fram och tillbaka i konstant fart.
    this.map.panTo(mal, {
      animate: true,
      duration: glidMs / 1000,
      easeLinearity: kor ? 1 : 0.4,
      // Ingen movestart per fix. Ingen lyssnar på den, och den enda effekten
      // vore ett extra varv i Leaflets händelsekedja en gång i sekunden.
      noMoveStart: true,
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
    // Vyn vi ritade för. omrita() jämför mot den och hoppar över omritningar
    // som ändå inte kan ge ett annat resultat.
    this._sistaVy = { c: this.map.getCenter(), z: this.map.getZoom() };

    // Bara det som är i bild, med marginal så nålar hinner finnas när man
    // drar. Kameror är fasta punkter över hela Sverige — resten av landet
    // behöver inte finnas i DOM:en medan du kör i Västerås.
    const vy = this.map.getBounds().pad(0.4);
    let synliga = hazards.filter(h => vy.contains([h.lat, h.lon]));

    // Zoomar man ut över hela landet ryms allt i bild igen. Då prioriteras
    // det som ligger närmast mitten av kartan — det man faktiskt tittar på.
    if (synliga.length > HazardMap.MAX_NALAR) {
      const c = this.map.getCenter();
      // En longitudgrad är kortare än en latitudgrad på våra breddgrader (~0,5
      // vid 59°N). Utan cos(lat)-vikten övervärderas nord–syd-avstånd och fel
      // nålar väljs som "närmast mitten". Väg om lon-ledet.
      const kx = Math.cos(c.lat * Math.PI / 180);
      synliga = synliga
        .map(h => [h, (h.lat - c.lat) ** 2 + ((h.lon - c.lng) * kx) ** 2])
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

  /**
   * Ritar om med senast kända lista. Används när kartan panorerats.
   *
   * Hoppar över omritningen när kartan knappt rört sig. Urvalet i render() görs
   * med 40 % marginal runt vyn (bounds.pad(0.4)), så varje nål som kan komma i
   * bild inom en tiondels skärm FINNS redan — att räkna om samma sak igen ger
   * exakt samma markörer och kostar bara batteri. Och den gör det en gång i
   * sekunden så länge man kör, vilket är precis när batteriet behövs.
   *
   * Tröskeln är avsiktligt mycket mindre än marginalen. Blir de för lika hinner
   * en nål glida in i bild innan omritningen sker.
   *
   * Gäller bara omritning som viewporten utlöst. En NY farolista går alltid via
   * render() direkt och passerar aldrig här.
   */
  omrita() {
    if (!this._sistaHazards) return;
    const f = this._sistaVy;
    if (f && f.z === this.map.getZoom()) {
      try {
        const b = this.map.getBounds();
        const diag = this.map.distance(b.getNorthWest(), b.getSouthEast());
        if (this.map.distance(this.map.getCenter(), f.c) < diag * 0.10) return;
      } catch {}
    }
    this.render(this._sistaHazards, this._sistaPos);
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
