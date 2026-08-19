// Vinterläge — varningar om det som faktiskt dödar folk på vintervägen.
//
// Polisen är en ekonomisk risk. Halkan är en livsrisk. På Västmanlands vägar
// är det isfläcken i skuggan vid Skultuna, snöbyn på E18 och rådjuret i
// diket i skymningen som ger de allvarliga olyckorna — inte kontrollen.
//
// Modulen gör tre saker och bara tre:
//   1. Hämtar en punktprognos från SMHI och cachar den så att den fungerar
//      offline och inte hamrar på servern.
//   2. Bedömer risk: halka, underkylt regn, snöfall, snörök, vilt.
//   3. Lämnar ifrån sig en nivå och en kort svensk mening.
//
// Den rör INTE DOM och den pratar INTE själv. Den som kopplar in den i
// alerts.js bestämmer när rösten används.
//
// ---------------------------------------------------------------------------
// VARNINGSDISCIPLIN — läs det här innan du ändrar några trösklar
// ---------------------------------------------------------------------------
// En förare som får höra "halkrisk" var nittionde sekund slutar lyssna. Då
// har appen gjort honom mindre säker än om den varit tyst, för nästa gång det
// verkligen gäller sitter varningen redan i bakgrundsbruset. Hela den nedre
// halvan av den här filen handlar därför om att hålla käften, inte om att
// varna. Fyra regler bär det:
//
//   A. Varna vid övergång, inte vid tillstånd. Halka som pågår är inte en ny
//      nyhet varje GPS-fix. Vi säger till när något börjar, sedan tyst.
//   B. Uppåt går fort, nedåt går långsamt. En risk som stiger ska höras
//      snabbt. En risk som sjunker ska ligga kvar länge innan vi släpper den,
//      annars fladdrar nivån över en tröskel och varje studs blir en ny
//      varning. Vägen torkar inte på två minuter.
//   C. Kategorikarantän. Samma sorts varning får inte komma tillbaka inom
//      45 minuter, oavsett vad mätvärdena gör.
//   D. Ett hårt tak per timme. Regel A–C är mekanismen; taket är skyddsnätet
//      om mekanismen har en bugg. Tre varningar per timme, punkt.
//
// ---------------------------------------------------------------------------
// KÄLLAN
// ---------------------------------------------------------------------------
// SMHI:s gamla pmp3g-API (opendata-download-metfcst.smhi.se/.../pmp3g/version/2)
// lades ned 2026-03-31 och svarar numera 404 på allt. Efterträdaren heter
// snow1g version 1, ligger på samma värd och har helt andra fältnamn: läsbara
// namn i ett platt data-objekt istället för den gamla listan med { name, values }.
// Alla namn nedan är avlästa ur ett riktigt svar och ur
// /api/category/snow1g/version/1/parameter.json, inte gissade.
//
// Nyckeltal från riktiga anrop:
//   - CORS: Access-Control-Allow-Origin: * — går att anropa direkt från appen.
//   - Cache-Control: max-age=3600. Prognosen körs om varje timme, ny körning
//     ligger uppe cirka 15–20 minuter över hel timme.
//   - Full serie 84 steg / ~69 kB. Med ?parameters=…&timeseries=14 blir det
//     drygt 6 kB. Elva gånger mindre över mobildata, samma information för oss.
//   - Utanför modellområdet: HTTP 404 med texten "Requested point is out of
//     bounds". Sverige ligger med god marginal innanför.

import { sunTimes } from './util.js';

/* ============================ Källa och format ============================ */

const SMHI_BASE = 'https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1';

// Bara det vi faktiskt räknar på. Varje parameter vi inte ber om är bytes
// föraren betalar för utan att få något tillbaka.
const PARAMS = [
  'air_temperature',                            // °C, 2 m
  'relative_humidity',                          // %, 2 m — ger daggpunkten
  'cloud_area_fraction',                        // oktas 0–8, total molnighet
  'wind_speed',                                 // m/s, 10 m
  'wind_speed_of_gust',                         // m/s, 10 m
  'visibility_in_air',                          // km
  'predominant_precipitation_type_at_surface',  // kategori 0–12
  'precipitation_amount_mean',                  // mm/h över intervallet
  'precipitation_frozen_part',                  // % fruset, −9 när det inte faller något
  'probability_of_precipitation',               // %
  'probability_of_frozen_precipitation',        // andel 0–1
  'symbol_code',                                // 1–27, väder­symbol
].join(',');

// Hur många steg vi ber om. De första ~60 stegen är timvisa, sedan glesnar
// serien till 3, 6 och 12 timmar. Vi behöver inte mer än ett halvt dygn:
// längre fram är det inte längre en körvarning utan en väderprognos, och
// väderprognoser finns det redan appar för.
const STEPS = 14;

// Fältet får värdet 9999 när modellen saknar data. Kommer med i svaret för
// t.ex. cloud_base_altitude när det är molnfritt — men gäller alla fält, så
// allt som läses måste passera igenom här.
const MISSING = 9999;

// precipitation_frozen_part har ett eget "inget värde": −9 betyder att det
// inte faller någon nederbörd alls. Dokumentationen påpekar det särskilt.
const FROZEN_PART_NONE = -9;

/**
 * predominant_precipitation_type_at_surface, direkt ur SMHI:s tabell.
 * De frusna typerna är hela poängen med den här modulen.
 */
export const PTYPE = {
  NONE: 0,
  RAIN: 1,
  THUNDER: 2,
  FREEZING_RAIN: 3,      // underkylt regn — det farligaste väglaget som finns
  MIXED_ICE: 4,
  SNOW: 5,
  WET_SNOW: 6,
  RAIN_AND_SNOW: 7,
  ICE_PELLETS: 8,
  GRAUPEL: 9,
  HAIL: 10,
  DRIZZLE: 11,
  FREEZING_DRIZZLE: 12,  // underkylt duggregn — lika halt, syns nästan inte
};

/** Nederbördstyper som lägger is eller löst underlag på vägbanan. */
const FREEZING_TYPES = new Set([PTYPE.FREEZING_RAIN, PTYPE.FREEZING_DRIZZLE]);
const SNOW_TYPES = new Set([PTYPE.SNOW, PTYPE.WET_SNOW, PTYPE.GRAUPEL]);
const MIX_TYPES = new Set([PTYPE.MIXED_ICE, PTYPE.RAIN_AND_SNOW, PTYPE.ICE_PELLETS]);

/* ================================ Nivåer ================================= */

/**
 * Fyra nivåer, och bara två av dem hörs.
 *
 * INFO finns för att gränssnittet ska kunna visa något utan att rösten går
 * igång. Skillnaden mellan "det är kallt" och "det är halt" är precis den
 * skillnad som avgör om föraren orkar lyssna nästa gång.
 */
export const LEVEL = { NONE: 0, INFO: 1, CAUTION: 2, SEVERE: 3 };

/** Under den här nivån säger vi ingenting högt. */
const SPEAK_FROM = LEVEL.CAUTION;

/* ============================== Inställningar ============================ */

const DEFAULTS = {
  /* --- Hämtning --- */
  refreshMs: 30 * 60000,      // SMHI kör om varje timme; 30 min fångar ny körning
                              // utan att fråga i onödan
  minFetchGapMs: 5 * 60000,   // absolut golv mellan två anrop, oavsett vad som
                              // händer. Skydd mot GPS-hopp och mot buggar i
                              // anropskedjan — SMHI ska inte behöva märka oss.
  movedRefetchM: 12000,       // ny prognos när vi kört 12 km. Snöbyar är
                              // lokala; 12 km är ungefär tio minuters landsväg
                              // och fem anrop på sträckan Västerås–Stockholm.
  staleMaxMs: 12 * 3600_000,  // äldre prognos än så här slutar vi lita på. Då
                              // säger vi hellre ingenting än något gammalt.
  retryBaseMs: 60000,         // backoff efter misslyckat anrop
  retryMaxMs: 30 * 60000,
  fetchTimeoutMs: 12000,

  /* --- Hysteres, se regel B --- */
  riseHoldMs: 120000,         // en höjd nivå måste hålla i två minuter innan
                              // den räknas. Prognosen ändras ändå bara varje
                              // timme, så fördröjningen kostar ingenting —
                              // den skyddar mot en enstaka skum hämtning och
                              // mot att ett tröskelvärde studsar när bilen
                              // rör sig mellan två griddpunkter.
  severeRiseHoldMs: 30000,    // underkylt regn får inte vänta två minuter.
  fallHoldMs: 25 * 60000,     // nedåt tar 25 minuter. En väg som varit hal är
                              // inte torr för att lufttemperaturen kröp över
                              // en tröskel. Det här är också det som gör att
                              // en nivå inte kan studsa ner och upp och ge
                              // två varningar för samma väder.

  /* --- Tystnad, se regel A, C och D --- */
  minGapMs: 20 * 60000,       // minst 20 minuter mellan två uttalade
                              // vintervarningar av vilket slag som helst
  severeMinGapMs: 8 * 60000,  // en eskalering till SEVERE får bryta minGapMs,
                              // men inte oftare än var åttonde minut
  categoryCooldownMs: 45 * 60000,  // samma kategori: en gång per 45 minuter
  lateralCooldownMs: 90 * 60000,   // se #considerSpeaking. Byter vädret bara
                              // skepnad utan att bli värre är det ingen nyhet
                              // för föraren, som redan har sänkt farten.
  maxPerHour: 3,              // hårt tak. Skyddsnät, inte mekanism.

  /* --- När det över huvud taget är meningsfullt att varna --- */
  minSpeedKmh: 20,            // en stillastående bil kan inte sladda, och den
                              // som just startat appen på uppfarten ska inte
                              // mötas av en röst
};

/* ============================ Ren meteorologi ============================ */

/**
 * Daggpunkt ur temperatur och relativ fuktighet, Magnus-formeln.
 *
 * Daggpunkten är nyckeln till halka och SMHI ger den inte direkt. Ligger
 * daggpunkten över vägbanans temperatur fäller luften ut fukt på asfalten.
 * Är vägbanan samtidigt under noll blir den fukten is — och det är rimfrost
 * och svartis, alltså den halka man inte ser förrän man ligger i diket.
 */
export function dewPoint(tempC, rhPercent) {
  if (!Number.isFinite(tempC) || !Number.isFinite(rhPercent)) return null;
  const rh = Math.min(100, Math.max(1, rhPercent));
  const a = 17.62, b = 243.12;
  const g = (a * tempC) / (b + tempC) + Math.log(rh / 100);
  return (b * g) / (a - g);
}

/**
 * Uppskattad vägbanetemperatur.
 *
 * DET HÄR ÄR EN GISSNING, och den viktigaste raden i hela filen att förstå.
 * SMHI mäter luften två meter över marken. Vägbanan är något annat. En klar,
 * vindstilla natt strålar asfalten ut värme mot rymden utan att molnen
 * skickar tillbaka något och utan att vinden blandar om luften. Då ligger
 * ytan typiskt 3–5 grader under lufttemperaturen. Det är därför man kan åka
 * på svartis när termometern i bilen visar plus två.
 *
 * Modellen: full effekt kräver natt, klart och stilla. Varje moln och varje
 * meter per sekund vind äter av avkylningen. Dagtid sätter vi den till noll
 * — solen värmer asfalten mer än den strålar bort, och den som gissar fel åt
 * det hållet varnar för halka mitt på dagen i mars och blir ignorerad.
 *
 * Broar, viadukter och vägbank över myr kyls fortare än så här. Det kan vi
 * inte modellera utan att veta var vi är på vägen, så det får ligga i texten
 * som varnas istället.
 */
export function estimateRoadTemp({ airTemp, cloudOktas, windMs, nightFactor }) {
  if (!Number.isFinite(airTemp)) return null;

  // Molnfritt = 1, helmulet = 0. Oktas går 0–8.
  const clearness = Number.isFinite(cloudOktas)
    ? Math.min(1, Math.max(0, (8 - cloudOktas) / 8))
    : 0.5;                                   // saknas molndata: anta halvklart

  // Vind blandar om luftlagret närmast marken och tar bort avkylningen.
  // Under 1,5 m/s full effekt, över 5 m/s ingen alls.
  const w = Number.isFinite(windMs) ? windMs : 3;
  const calm = Math.min(1, Math.max(0, (5 - w) / 3.5));

  const night = Math.min(1, Math.max(0, nightFactor ?? 0));

  const drop = 3.5 * clearness * calm * night;
  return airTemp - drop;
}

/**
 * Hur "natt" är det, 0–1.
 *
 * Utstrålningen börjar redan innan solen gått ner och håller i sig till en
 * bit efter soluppgången. Vi rampar därför mjukt istället för att slå om
 * binärt vid horisonten — annars skulle den uppskattade vägbanetemperaturen
 * hoppa tre grader på en minut och dra med sig varningsnivån.
 */
function nightFactor(lat, lon, at) {
  const { sunrise, sunset, polar } = sunTimes(lat, lon, at);
  if (polar === 'night') return 1;
  if (polar === 'day') return 0;
  if (!sunrise || !sunset) {
    const h = at.getHours();
    return h < 6 || h >= 19 ? 1 : 0;         // nödfall, ska inte hända i Sverige
  }
  const min = 60000;
  const t = at.getTime();
  // Full nattverkan en timme efter solnedgång, tillbaka på noll en timme
  // efter soluppgång.
  const dusk = sunset.getTime() - 60 * min;
  const nightOn = sunset.getTime() + 60 * min;
  const dawnOff = sunrise.getTime() + 60 * min;
  const dawnStart = sunrise.getTime() - 30 * min;

  if (t >= nightOn || t <= dawnStart) return 1;
  if (t > dusk && t < nightOn) return (t - dusk) / (nightOn - dusk);
  if (t > dawnStart && t < dawnOff) return 1 - (t - dawnStart) / (dawnOff - dawnStart);
  return 0;
}

/* ========================= Läsning ur SMHI-svaret ========================= */

/** Ett fält ur en rad, med 9999 översatt till null istället för till nonsens. */
function val(row, name) {
  const v = row?.data?.[name];
  if (v == null || v === MISSING) return null;
  return typeof v === 'number' ? v : null;
}

/**
 * Raden som gäller för en given tidpunkt.
 *
 * Viktigt om tiderna: alla parametrar utom nederbörden gäller momentant vid
 * `time`. Nederbörden är fördelad över intervallet från
 * `intervalParametersStartTime` fram till `time`. Vill man veta vad som faller
 * just nu är det alltså den första raden vars `time` ligger framför oss som
 * är rätt — inte den senast passerade.
 */
function rowAt(series, at) {
  if (!series?.length) return null;
  const t = at instanceof Date ? at.getTime() : at;
  for (const r of series) {
    if (new Date(r.time).getTime() >= t) return r;
  }
  return series[series.length - 1];
}

/** Raderna inom ett tidsfönster runt nu, i timmar. Negativt = bakåt. */
function rowsBetween(series, at, fromH, toH) {
  if (!series?.length) return [];
  const t = at instanceof Date ? at.getTime() : at;
  const lo = t + fromH * 3600_000, hi = t + toH * 3600_000;
  return series.filter(r => {
    const rt = new Date(r.time).getTime();
    return rt >= lo && rt <= hi;
  });
}

/* ============================ Väderbedömning ============================= */

/**
 * Bedömer väglaget ur en prognosrad. Ren funktion — inga sidoeffekter, inget
 * tidsberoende utöver det som skickas in. Det gör den testbar och gör att
 * hysteresen nedan är det enda stället där tid spelar roll.
 *
 * @returns {{level:number, key:string|null, phrase:string|null, detail:object}}
 */
export function assessWeather(row, ctx = {}) {
  const detail = {};
  if (!row) return { level: LEVEL.NONE, key: null, phrase: null, detail };

  const temp = val(row, 'air_temperature');
  const rh = val(row, 'relative_humidity');
  const cloud = val(row, 'cloud_area_fraction');
  const wind = val(row, 'wind_speed');
  const gust = val(row, 'wind_speed_of_gust');
  const visKm = val(row, 'visibility_in_air');
  const ptype = val(row, 'predominant_precipitation_type_at_surface');
  const rate = val(row, 'precipitation_amount_mean');
  const pop = val(row, 'probability_of_precipitation');
  const frozenPct = val(row, 'precipitation_frozen_part');

  const dew = dewPoint(temp, rh);
  const roadTemp = estimateRoadTemp({
    airTemp: temp, cloudOktas: cloud, windMs: wind, nightFactor: ctx.nightFactor,
  });

  // Faller det något värt namnet? probability_of_precipitation gäller minst
  // 0,1 mm. Vi kräver både sannolikhet och mängd — annars varnar vi för
  // enstaka droppar som modellen ändå inte tror på.
  //
  // Fotnot om precipitation_amount_min/max: de är minimum och maximum bland
  // de ensemblemedlemmar som HAR nederbörd. En rad kan därför visa mean 0,0
  // och min 0,2 samtidigt. De går alltså inte att använda som spann. Vi
  // håller oss till mean.
  const raining = (rate ?? 0) >= 0.1 && (pop ?? 0) >= 30;
  const frozen = frozenPct != null && frozenPct !== FROZEN_PART_NONE ? frozenPct : 0;

  Object.assign(detail, { temp, dew, roadTemp, cloud, wind, gust, visKm, ptype, rate, pop, frozen });

  /* --- 1. Underkylt regn. Ingenting annat kommer i närheten. --- */
  // Regn som fryser i kontakt med vägbanan lägger en spegel på hela vägen
  // samtidigt, inte i fläckar. Sandning hinner sällan före. Den här ska höras
  // även om den bryter mot varenda tysthetsregel vi har.
  if (FREEZING_TYPES.has(ptype)) {
    return {
      level: LEVEL.SEVERE,
      key: 'underkylt',
      phrase: 'Underkylt regn. Vägen kan bli spegelhal på en gång. Sänk farten rejält.',
      detail,
    };
  }

  /* --- 2. Blötsnö och snöblandat regn på kall vägbana --- */
  // Blandad nederbörd som landar på en yta runt noll ger modd som fryser
  // underifrån. Vanligt i Mälardalen och underskattat.
  if (raining && MIX_TYPES.has(ptype) && roadTemp != null && roadTemp <= 1) {
    return {
      level: LEVEL.SEVERE,
      key: 'blandat',
      phrase: 'Snöblandat regn på kall vägbana. Modd och is. Håll extra avstånd.',
      detail,
    };
  }

  /* --- 3. Snöfall --- */
  // Intensiteten är mm vatten per timme, inte centimeter snö. Ungefär tio
  // gånger så mycket snö i volym. 0,4 mm/h märks på väggreppet, 1,2 mm/h
  // lägger igen vägen fortare än plogen hinner.
  if (raining && (SNOW_TYPES.has(ptype) || frozen >= 60)) {
    const heavy = (rate ?? 0) >= 1.2 || (visKm != null && visKm < 1);
    const moderate = (rate ?? 0) >= 0.4;
    if (heavy) {
      return {
        level: LEVEL.SEVERE,
        key: 'snofall',
        phrase: 'Kraftigt snöfall. Dålig sikt och löst underlag. Sänk farten.',
        detail,
      };
    }
    if (moderate) {
      return {
        level: LEVEL.CAUTION,
        key: 'snofall',
        phrase: 'Snöfall. Sämre grepp. Öka avståndet framåt.',
        detail,
      };
    }
    // Lätt snöfall på plusgradig väg är bara blött. Ingen varning, men
    // gränssnittet får gärna visa det.
    if (roadTemp != null && roadTemp <= 0) {
      return {
        level: LEVEL.INFO, key: 'snofall',
        phrase: 'Lätt snöfall på kall vägbana.', detail,
      };
    }
  }

  /* --- 4. Snörök och drivsnö --- */
  // Kräver löst, torrt snö på marken och vind som orkar lyfta det. Nära noll
  // packas snön och ligger kvar; under ett par minusgrader flyger den.
  // Vi vet INTE om det ligger snö på marken — se ctx.recentSnow, som är en
  // gissning byggd på om det snöat i den prognos vi har sparad.
  const drifty = (gust ?? wind ?? 0) >= 12 || (wind ?? 0) >= 8;
  if (drifty && temp != null && temp <= -2 && ctx.recentSnow) {
    const severe = (gust ?? 0) >= 16 && visKm != null && visKm < 2;
    return {
      level: severe ? LEVEL.SEVERE : LEVEL.CAUTION,
      key: 'snorok',
      phrase: severe
        ? 'Snörök i hård vind. Sikten kan försvinna helt på öppna sträckor.'
        : 'Blåsigt och lös snö. Räkna med snörök och drivor på öppna sträckor.',
      detail,
    };
  }

  /* --- 5. Halka utan nederbörd: rimfrost och svartis --- */
  // Två villkor måste vara uppfyllda samtidigt: vägbanan under noll, och fukt
  // som kan lägga sig på den. Fukten kommer antingen ur luften (daggpunkten
  // ligger på eller över ytans temperatur) eller ur att det nyss regnat.
  //
  // Det är här "luften är inte vägen" betalar sig. Med air = +2, klart och
  // vindstilla nattetid hamnar roadTemp runt −1,5. En app som bara tittar på
  // lufttemperaturen är tyst precis den natten då den behövdes.
  if (roadTemp != null && roadTemp <= 0.5) {
    // (a) Fukten fäller ut redan nu: daggpunkten ligger på eller över ytan.
    //     Det här är rimfrosten som lägger sig medan bilen står parkerad.
    const frostDeposits = dew != null && dew >= roadTemp - 0.5;

    // (b) Vägen är redan blöt sedan tidigare nederbörd och fryser till.
    const wetRoad = ctx.recentRain === true;

    // (c) Klar, stilla natt med daggpunkt på eller under noll.
    //     Utstrålningen slutar inte när ytan når lufttemperaturen — den
    //     fortsätter tills ytan möter daggpunkten, för det är först då
    //     kondensationen frigör värme och bromsar. Ligger daggpunkten under
    //     noll betyder det att ytan är på väg under noll med fukt på gång, och
    //     att det som fälls ut blir is och inte dagg. Därför räknas det som
    //     halkrisk även när termometern visar ett par plusgrader. Det är just
    //     den natten som lurar folk: bilens display säger +2 och rutan är torr.
    const clearSky = cloud != null && cloud <= 2;
    const calmAir = (wind ?? 3) <= 3;
    const radiativeNight = clearSky && calmAir && (ctx.nightFactor ?? 0) >= 0.8;
    const dewBelowFreezing = dew != null && dew <= 0;
    const coolingToFrost = radiativeNight && dewBelowFreezing;

    if (frostDeposits || wetRoad || coolingToFrost) {
      // Den elakaste varianten: luften visar plus, vägen ligger under noll.
      // Föraren har ingen chans att gissa det själv, så säg ut skillnaden.
      const airLies = temp != null && temp >= 1;
      if (roadTemp <= -1 || wetRoad) {
        return {
          level: LEVEL.CAUTION,
          key: 'halka',
          phrase: airLies
            ? 'Halkrisk. Vägbanan kan ligga under noll trots plusgrader i luften. Broar och skuggpartier först.'
            : 'Halkrisk. Is kan ligga på vägen, särskilt på broar och i skugga.',
          detail,
        };
      }
      return {
        level: LEVEL.INFO, key: 'halka',
        phrase: 'Vägbanan ligger nära noll. Håll uppsikt på broar.', detail,
      };
    }
    // Torr luft och torr väg: kallt men inte halt. Ingen varning.
    return { level: LEVEL.INFO, key: 'kallt', phrase: 'Kallt men torrt väglag.', detail };
  }

  return { level: LEVEL.NONE, key: null, phrase: null, detail };
}

/* ============================= Viltbedömning ============================= */

/**
 * Vilt. Här finns ingen data, och det ska sägas rakt ut.
 *
 * Det finns inget gratis realtidsflöde över var älg, rådjur och vildsvin
 * befinner sig. Viltolycksrådet publicerar statistik i efterhand, inte
 * positioner. Vi hittar alltså INTE på en datakälla. Det vi gör är att räkna
 * ut när risken statistiskt sett är som högst och säga det en gång:
 *
 *   Tid   — de flesta viltolyckorna sker i gryning och skymning, när djuren
 *           rör sig och när förarens ögon är som sämst. Räknat på riktig
 *           soltid för positionen, inte på klockslag. Solen går ner strax
 *           efter tre i december och strax före tio i juni i Västerås.
 *   Årstid— vildsvin och rådjur toppar under hösten och vintern. Rådjuren har
 *           även en vårtopp i maj, men den här modulen är ett vinterläge och
 *           bygger inte varningen på den.
 *   Vägtyp— landsväg med 80 eller 90 är där olyckorna sker och där farten gör
 *           dem allvarliga. I 40-zon i Västerås centrum varnar vi inte.
 *
 * Nivån är takad till CAUTION. En statistisk sannolikhet får aldrig låta som
 * en observation — säger vi SEVERE om något vi inte har sett urholkar vi
 * ordet inför den dagen det faktiskt ligger underkylt regn på vägen.
 */
export function assessWildlife({ lat, lon, at = new Date(), speedLimit = null }) {
  const { sunrise, sunset, polar } = sunTimes(lat, lon, at);
  if (polar || !sunrise || !sunset) return { level: LEVEL.NONE, key: null, phrase: null, detail: {} };

  const min = 60000;
  const t = at.getTime();
  const toSunset = (t - sunset.getTime()) / min;   // + = efter solnedgång
  const toSunrise = (t - sunrise.getTime()) / min; // − = före soluppgång

  // Fönstervikt. Toppen ligger strax efter solnedgången och strax före
  // soluppgången — det är då djuren rör sig och sikten är sämst.
  let windowW = 0, when = null;
  if (toSunset >= -45 && toSunset <= 120) {
    windowW = toSunset >= -15 && toSunset <= 60 ? 1 : 0.6;
    when = 'skymning';
  } else if (toSunrise >= -75 && toSunrise <= 30) {
    windowW = toSunrise >= -45 && toSunrise <= 0 ? 0.9 : 0.55;
    when = 'gryning';
  }
  if (!windowW) return { level: LEVEL.NONE, key: null, phrase: null, detail: { when: null } };

  // Årstidsvikt. Okt–jan är värst i Västmanland.
  const m = at.getMonth();                       // 0 = januari
  const seasonW =
    [9, 10, 11, 0].includes(m) ? 1 :
    [8, 1].includes(m) ? 0.85 :
    [2, 3, 4].includes(m) ? 0.7 : 0.5;

  // Vägtypsvikt ur hastighetsgränsen, som appen redan känner till.
  // Okänd gräns får ett försiktigt mellanvärde: Västmanland utanför Västerås
  // är mestadels landsväg, men vi gissar inte högt på tunn grund.
  const roadW =
    speedLimit == null ? 0.6 :
    speedLimit >= 90 ? 1 :
    speedLimit >= 70 ? 0.9 :
    speedLimit >= 60 ? 0.6 : 0.15;

  const score = windowW * seasonW * roadW;
  const detail = { when, windowW, seasonW, roadW, score, sunrise, sunset };

  if (score >= 0.55) {
    return {
      level: LEVEL.CAUTION,
      key: 'vilt',
      phrase: when === 'gryning'
        ? 'Gryning. Nu rör sig viltet mest. Håll uppsikt i vägkanten.'
        : 'Skymning. Nu rör sig viltet mest. Håll uppsikt i vägkanten.',
      detail,
    };
  }
  if (score >= 0.3) {
    return { level: LEVEL.INFO, key: 'vilt', phrase: 'Viltrisk i skymningen.', detail };
  }
  return { level: LEVEL.NONE, key: null, phrase: null, detail };
}

/* ============================== Prognoscache ============================= */

const CACHE_KEY = 'pv.vinter.v1';

const loadCache = () => {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || null; } catch { return null; }
};
const saveCache = c => {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch {}
};

/** Grovt avstånd i meter. Räcker gott för att avgöra "har vi kört långt". */
function roughDistance(aLat, aLon, bLat, bLon) {
  const dy = (bLat - aLat) * 111320;
  const dx = (bLon - aLon) * 111320 * Math.cos(aLat * Math.PI / 180);
  return Math.hypot(dx, dy);
}

/**
 * Hämtar punktprognosen. Kastar vid fel — anroparen bestämmer vad som händer,
 * och svaret är alltid "behåll den gamla prognosen".
 */
export async function fetchForecast(lat, lon, { timeoutMs = 12000, steps = STEPS } = {}) {
  // SMHI vill ha lon före lat i sökvägen, och fler än sex decimaler ger bara
  // sämre cacheträffar hos dem utan att ge oss något.
  const url = `${SMHI_BASE}/geotype/point/lon/${lon.toFixed(4)}/lat/${lat.toFixed(4)}/data.json`
    + `?parameters=${PARAMS}&timeseries=${steps}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (res.status === 404) throw new Error('Punkten ligger utanför SMHI:s modellområde.');
    if (!res.ok) throw new Error(`SMHI svarade ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json.timeSeries) || !json.timeSeries.length) {
      throw new Error('Tom prognos från SMHI');
    }
    return {
      lat, lon,
      createdTime: json.createdTime,
      referenceTime: json.referenceTime,
      series: json.timeSeries,
      fetchedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ============================== Tjänsten ================================ */

/**
 * Vinterläget som appen pratar med.
 *
 * Två oberoende kanaler, väder och vilt, med var sin hysteres men gemensamt
 * tak. Skälet är att de kan vara sanna samtidigt: ligger man i ett snöfall
 * ska inte det för alltid tysta viltvarningen i skymningen, och tvärtom.
 * Delar de däremot inte timtak och minsta lucka kan föraren få två varningar
 * i rad, vilket är precis det vi försöker undvika.
 */
export class WinterService extends EventTarget {
  constructor(opts = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
    this.enabled = opts.enabled ?? true;

    this.forecast = loadCache();      // överlever omstart och fungerar offline
    this.lastError = null;
    this._fetching = false;
    this._lastFetchAt = 0;
    this._retryAt = 0;
    this._retryDelay = 0;

    // Kanaltillstånd: vad vi observerat, vad som gäller efter hysteres,
    // och vad som faktiskt sagts högt.
    this._ch = {
      weather: this.#newChannel(),
      wildlife: this.#newChannel(),
    };
    this._spokenAt = [];              // tidpunkter, för timtaket
    this._lastSpokeAt = 0;
  }

  #newChannel() {
    return {
      official: { level: LEVEL.NONE, key: null, phrase: null },
      pending: null,                  // { level, key, phrase, since }
      // Den pågående episoden. Nollställs när kanalen faller under
      // varningsnivå, så att samma väder kan varnas om igen nästa gång det
      // kommer tillbaka — men inte medan det pågår.
      spoken: { level: LEVEL.NONE, key: null, at: 0 },
      // Senaste yttrandet på kanalen. Överlever episodbytet, för det är den
      // här tidpunkten som avgör om föraren nyss hörde något.
      lastSpokeAt: 0,
      cooldown: new Map(),            // key -> { at, level } senast uttalad
    };
  }

  setOptions(o) { this.opts = { ...this.opts, ...o }; }

  /** Ny körning. Nollställ det som ska gälla per resa, behåll prognosen. */
  reset() {
    this._ch.weather = this.#newChannel();
    this._ch.wildlife = this.#newChannel();
    this._spokenAt = [];
    this._lastSpokeAt = 0;
  }

  /** Läge just nu, för gränssnittet. Inga varningar, inget ljud. */
  get status() {
    const f = this.forecast;
    const age = f ? Date.now() - f.fetchedAt : null;
    return {
      weather: { ...this._ch.weather.official },
      wildlife: { ...this._ch.wildlife.official },
      forecastAgeMs: age,
      stale: !f || age > this.opts.staleMaxMs,
      createdTime: f?.createdTime || null,
      offline: !navigator.onLine,
      error: this.lastError,
    };
  }

  /**
   * Anropas en gång per GPS-fix, precis som SpeedLimitService.update.
   *
   * @param {{lat,lon,speedKmh,speedLimit}} fix  speedLimit är hastighetsgränsen
   *        från SpeedLimitService, om den är känd. Används bara för vilt.
   * @returns {{status:object, warnings:Array<{level,key,phrase,priority,channel}>}}
   *          warnings är tom nästan alltid. Det är meningen.
   */
  update(fix, now = Date.now()) {
    if (!this.enabled || !fix || !Number.isFinite(fix.lat)) {
      return { status: this.status, warnings: [] };
    }

    this.#maybeFetch(fix, now);

    const at = new Date(now);
    const nf = nightFactor(fix.lat, fix.lon, at);

    // Bedöm — även utan prognos, för viltdelen behöver bara sol och kalender.
    const series = this.#usableSeries(now);
    const weather = assessWeather(rowAt(series, at), {
      nightFactor: nf,
      recentSnow: this.#recentSnow(series, at),
      recentRain: this.#recentRain(series, at),
    });
    const wildlife = assessWildlife({
      lat: fix.lat, lon: fix.lon, at, speedLimit: fix.speedLimit ?? null,
    });

    // Hysteres först, tystnadsregler sedan. Ordningen spelar roll: en nivå
    // som aldrig hann bli officiell ska aldrig ens övervägas för uppläsning.
    this.#settle('weather', weather, now);
    this.#settle('wildlife', wildlife, now);

    const speed = fix.speedKmh ?? 0;

    // Kandidater tas fram utan att bokföras. Två varningar i samma ögonblick
    // är en varning för mycket, så först när vi vet vilken som vinner skrivs
    // den in i historiken — annars skulle den bortvalda ändå ha bränt sin
    // kategorikarantän och tystats nästa gång den behövdes.
    const candidates = [];
    for (const name of ['weather', 'wildlife']) {
      const c = this.#considerSpeaking(name, now, speed);
      if (c) candidates.push(c);
    }
    candidates.sort((a, b) => b.warning.level - a.warning.level);

    const warnings = [];
    if (candidates.length) {
      candidates[0].commit();
      warnings.push(candidates[0].warning);
    }

    for (const w of warnings) this.#emit('warning', w);
    return { status: this.status, warnings };
  }

  /* ------------------------- Hämtning och cache ------------------------- */

  /**
   * Hämtar bara när det behövs. Tre skäl finns: vi har ingen prognos, den vi
   * har är gammal, eller vi har kört så långt att den gäller ett annat väder.
   * Alla tre passerar samma golv på fem minuter mellan anrop.
   */
  #maybeFetch(fix, now) {
    if (this._fetching) return;
    if (now - this._lastFetchAt < this.opts.minFetchGapMs) return;
    if (this._retryAt && now < this._retryAt) return;

    const f = this.forecast;
    const stale = !f || now - f.fetchedAt > this.opts.refreshMs;
    const moved = f && roughDistance(f.lat, f.lon, fix.lat, fix.lon) > this.opts.movedRefetchM;
    if (!stale && !moved) return;

    this._fetching = true;
    this._lastFetchAt = now;

    fetchForecast(fix.lat, fix.lon, { timeoutMs: this.opts.fetchTimeoutMs })
      .then(fc => {
        this.forecast = fc;
        saveCache(fc);
        this.lastError = null;
        this._retryDelay = 0;
        this._retryAt = 0;
        this.#emit('forecast', { createdTime: fc.createdTime, steps: fc.series.length });
      })
      .catch(err => {
        // Ett misslyckat anrop får aldrig kosta något. Vi har kvar den gamla
        // prognosen, och en gammal prognos är nästan alltid bättre än inget:
        // vädret ändrar sig långsammare än mobiltäckningen i Bergslagen.
        this.lastError = err.message || 'Kunde inte hämta väder';
        this._retryDelay = this._retryDelay
          ? Math.min(this.opts.retryMaxMs, this._retryDelay * 2)
          : this.opts.retryBaseMs;
        this._retryAt = Date.now() + this._retryDelay;
        this.#emit('error', { message: this.lastError, retryInMs: this._retryDelay });
      })
      .finally(() => { this._fetching = false; });
  }

  /** Prognosen om den är ung nog att lita på, annars ingenting. */
  #usableSeries(now) {
    const f = this.forecast;
    if (!f) return null;
    if (now - f.fetchedAt > this.opts.staleMaxMs) return null;
    return f.series;
  }

  /**
   * Har det snöat nyligen? Behövs för snörök, och är en gissning.
   *
   * Vi har inga observationer bakåt, men en cachad prognos innehåller rader
   * som hunnit bli dåtid. Är cachen fyra timmar gammal ser vi alltså fyra
   * timmar bakåt gratis. Är den nyss hämtad ser vi bara framåt, och då blir
   * bedömningen svagare. Det får den vara — alternativet är att hitta på.
   */
  #recentSnow(series, at) {
    if (!series) return false;
    return rowsBetween(series, at, -6, 2).some(r => {
      const p = val(r, 'predominant_precipitation_type_at_surface');
      const fp = val(r, 'precipitation_frozen_part');
      const rate = val(r, 'precipitation_amount_mean') ?? 0;
      const frozen = fp != null && fp !== FROZEN_PART_NONE ? fp : 0;
      return rate >= 0.1 && (SNOW_TYPES.has(p) || frozen >= 60);
    });
  }

  /** Har vägen hunnit bli blöt? Blöt väg som fryser är svartis. */
  #recentRain(series, at) {
    if (!series) return false;
    return rowsBetween(series, at, -4, 1).some(r =>
      (val(r, 'precipitation_amount_mean') ?? 0) >= 0.2 &&
      (val(r, 'predominant_precipitation_type_at_surface') ?? 0) !== PTYPE.NONE
    );
  }

  /* ------------------------------ Hysteres ------------------------------ */

  /**
   * Regel B. En ny bedömning blir inte officiell direkt.
   *
   * Uppåt: 2 minuter, eller 30 sekunder om det är SEVERE. Prognosen byts ändå
   * bara en gång i timmen, så väntan kostar inget mot vädret — den skyddar
   * mot att en enstaka hämtning eller en griddgräns knuffar oss över en
   * tröskel och tillbaka igen.
   *
   * Nedåt: 25 minuter. Det är den asymmetrin som är hela poängen. Vore
   * fallet lika snabbt som stigningen skulle en temperatur som pendlar kring
   * en tröskel ge en ny varning varje gång den passerar, och det är precis
   * den upplevelsen som lär föraren att stänga av rösten.
   */
  #settle(name, next, now) {
    const ch = this._ch[name];
    const cur = ch.official;

    const same = next.level === cur.level && next.key === cur.key;
    if (same) { ch.pending = null; return; }

    if (!ch.pending || ch.pending.level !== next.level || ch.pending.key !== next.key) {
      ch.pending = { ...next, since: now };
      return;
    }

    const rising = next.level > cur.level;
    const hold = rising
      ? (next.level >= LEVEL.SEVERE ? this.opts.severeRiseHoldMs : this.opts.riseHoldMs)
      : (next.level < cur.level ? this.opts.fallHoldMs : this.opts.riseHoldMs);

    if (now - ch.pending.since < hold) return;

    ch.official = { level: next.level, key: next.key, phrase: next.phrase, detail: next.detail };
    ch.pending = null;

    // Episoden är slut när kanalen sjunkit under varningsnivå. Då glöms vad
    // som sagts under den, så att samma väder får varnas om nästa gång det
    // kommer tillbaka. Utan den här raden skulle ett snöfall på morgonen
    // tysta kvällens snöfall för alltid. Kategorikarantänen i ch.cooldown
    // lever vidare och ser till att "nästa gång" inte betyder om tio minuter.
    if (ch.official.level < SPEAK_FROM) ch.spoken = { level: LEVEL.NONE, key: null, at: 0 };

    this.#emit('status', { channel: name, ...ch.official });
  }

  /* ------------------------------- Tystnad ------------------------------ */

  /**
   * Regel A, C och D. Här sägs nästan alltid nej, och det är designat så.
   *
   * Returnerar en kandidat, inte en varning: { warning, commit }. Ingenting
   * bokförs förrän anroparen kallar commit(), så att en kandidat som förlorar
   * mot en allvarligare inte bränner sin karantän i onödan.
   */
  #considerSpeaking(name, now, speedKmh) {
    const ch = this._ch[name];
    const o = ch.official;

    if (o.level < SPEAK_FROM || !o.key) return null;

    // Står bilen still finns ingen fara att varna för, och föraren håller
    // förmodligen på att ställa in appen.
    if (speedKmh < this.opts.minSpeedKmh) return null;

    // Regel A: bara vid övergång uppåt. Samma nivå på samma sak är inte en
    // nyhet, och en sjunkande risk är aldrig värd en mening.
    if (o.key === ch.spoken.key && o.level <= ch.spoken.level) return null;

    // Stiger risken på riktigt, eller byter den bara skepnad? Skillnaden
    // avgör allt nedan. Underkylt regn som blir kraftigt snöfall är inte
    // farligare än det var — föraren har redan saktat ner, och en ny mening
    // lär honom bara att rösten pratar i onödan.
    const rising = o.level > ch.spoken.level;

    // Regel C, del 1: kategorikarantän. Samma sorts varning får inte
    // återkomma inom 45 minuter om den inte har blivit allvarligare sedan
    // sist. Det är den här raden som gör att "halkrisk" är omöjlig att få
    // var nittionde sekund, hur mycket temperaturen än studsar kring noll.
    const prev = ch.cooldown.get(o.key);
    if (prev && now - prev.at < this.opts.categoryCooldownMs && o.level <= prev.level) return null;

    // Regel C, del 2: sidledes byte. Håller sig risken på samma nivå men
    // byter orsak krävs 90 minuter sedan kanalen sa något över huvud taget.
    // Utan den här regeln blir ett långt oväder till en radioserie: modd,
    // sedan snö, sedan underkylt, sedan snö igen.
    if (!rising && now - ch.lastSpokeAt < this.opts.lateralCooldownMs) return null;

    // Minsta lucka mellan två vintervarningar av vilket slag som helst. En
    // äkta eskalering till SEVERE får bryta den, men bara ner till åtta
    // minuter — så att inte ens en ishalka som förvärras blir tjatig.
    if (this._lastSpokeAt) {
      const need = (rising && o.level >= LEVEL.SEVERE)
        ? this.opts.severeMinGapMs
        : this.opts.minGapMs;
      if (now - this._lastSpokeAt < need) return null;
    }

    // Regel D: hårt tak per rullande timme. Skyddsnätet.
    const recent = this._spokenAt.filter(t => now - t < 3600_000);
    if (recent.length >= this.opts.maxPerHour) return null;

    // Vilt sägs en gång per skymning eller gryning, aldrig mer. Det är en
    // statistisk risk som inte förändras under fönstret, så en påminnelse
    // fem minuter senare tillför exakt ingenting. Fyra timmar täcker hela
    // fönstret utan att spärra kvällen efter att ha varnat i gryningen.
    if (name === 'wildlife' && prev && now - prev.at < 4 * 3600_000) return null;

    const warning = {
      channel: name,
      level: o.level,
      key: o.key,
      phrase: o.phrase,
      // Prioritet i samma skala som alerts.js använder: 2 avbryter det som
      // pågår, 1 ställer sig i kö.
      priority: o.level >= LEVEL.SEVERE ? 2 : 1,
      at: now,
      stale: this.status.stale,
    };

    const commit = () => {
      ch.spoken = { level: o.level, key: o.key, at: now };
      ch.lastSpokeAt = now;
      ch.cooldown.set(o.key, { at: now, level: o.level });
      this._lastSpokeAt = now;
      this._spokenAt = recent.concat(now);
    };

    return { warning, commit };
  }

  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
}

export default WinterService;
