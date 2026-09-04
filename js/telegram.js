// Telegram-spegeln -> rapporter.
//
// Facebook-gruppen "Här står polisen" går inte att läsa maskinellt: Meta
// stängde Groups API för inläggsläsning 2024. Det som finns kvar är att en
// admin speglar gruppens inlägg till en Telegram-kanal, och att vi läser den
// kanalen med Telegrams riktiga bot-API. Ingen villkorsrisk, dygnet runt.
//
// Den här filen är RENA LAGRET i den bryggan. Den gör tre saker och inget mer:
// plockar ut meddelanden ur en getUpdates-svarsstruktur, tolkar ett meddelande
// till antingen en rapport eller ett skäl till att det förkastades, och bygger
// den färdiga raden.
//
// Fyra saker styr designen:
//
//   Ingen token bor här. Boten pollas på serversidan. En bot-token i en
//   webbapp är samma sak som att ge bort boten — den som har den kan läsa allt
//   boten ser och skriva i dess namn. telegramUrl() bygger bara en adress åt
//   den som redan har token; den hämtar ingenting.
//
//   Ingen sida-effekt alls. Inget fetch, inget localStorage, ingen klocka som
//   inte går att skicka in. Geokodningen kommer in som en funktion, dedupen
//   som en mängd. Det är därför hela filen går att testa, och det är därför
//   samma kod kan köras i en webbläsare, i Deno på en edge-funktion och i
//   Node på en liten server.
//
//   Parsern äger reglerna. parseReportText() är exakt samma funktion som
//   rösten och knapparna använder. Ordlistorna kopieras inte hit — den gamla
//   bryggan i tools/telegram-bridge.md gjorde det, och en kopia av ett
//   nykterhetsfilter är ett filter som förr eller senare glider isär från
//   originalet. Här är det bara ett anrop.
//
//   Andrahandsuppgifter märks som andrahandsuppgifter. Någon i gruppen skrev
//   något, en admin speglade det, vi läste det efteråt. Det är svagare än en
//   förare som står på platsen och trycker på knappen, och kvalitetsfälten
//   sätts så att js/kvalitet.js får veta precis det.

import { parseReportText, isSobrietyCheck } from './parser.js';
// Visningstiden, inte trovärdighetstiden — se store.js VISNING_MINUTER.
// expires_at avgör bara om rapporten syns; hur mycket appen tror på den
// avgörs av TTL_MINUTES i js/kvalitet.js.
import { visningMinuter } from './store.js';
import { normalize, uid, clamp } from './util.js';

/**
 * Källa på rapporterna.
 *
 * Med flit 'facebook' och inte 'telegram', av tre skäl som pekar åt samma håll:
 *
 *   Det ÄR gruppens inlägg. Telegram är transporten, inte källan. En människa
 *   i Facebook-gruppen skrev texten; kanalen speglade den.
 *
 *   schema.sql tillåter bara app, voice, facebook och import. Att lägga till
 *   ett femte värde är en migrering på en tabell som redan är i drift.
 *
 *   js/kvalitet.js graderar efter källa: facebook 0,42 och okänd 0,45. Ett
 *   'telegram' som inte finns i den listan skulle alltså tyst räknas som
 *   MER pålitligt än ett Facebook-inlägg — samma text, högre betyg, bara för
 *   att den tog en annan väg in. Det vore en lögn i graderingen.
 *
 * Att skilja Telegram-bryggan från userscriptet går ändå: device_id är
 * 'tg-bridge' och external_id börjar på 'tg:'. Se vyn telegram_senaste i
 * supabase/telegram.sql.
 */
export const KALLA = 'facebook';

/** Enhets-id för allt som kommer via Telegram. Syns i databasen, inte i appen. */
export const BRYGGA_ENHET = 'tg-bridge';

/** Under 0,65 är tolkningen en gissning. Gissningar hör inte hemma på kartan. */
export const MIN_TILLIT = 0.65;

/**
 * Hur länge en text räknas som samma inlägg.
 *
 * Meddelande-id räcker nästan alltid. Men en spegel som körs om, en admin som
 * klistrar in samma inlägg en gång till, eller ett vidarebefordrat meddelande
 * ger ett nytt message_id för en text vi redan lagt ut. Textnyckeln fångar
 * det. Fönstret är längre än en varnings livslängd men mycket kortare än ett
 * dygn — "polis vid Erikslund" är samma varning i eftermiddag men en ny
 * varning nästa vecka.
 */
export const DEDUP_FONSTER_MS = 3 * 60 * 60 * 1000;

/** Längst text vi sparar i note. Samma gräns som Facebook-ingesten. */
const NOTE_MAX = 240;
const LABEL_MAX = 120;

/** Varför ett meddelande inte blev en rapport. */
export const SKAL = {
  TOM:          'tom',           // ingen text och ingen bildtext
  FEL_CHATT:    'fel-chatt',     // boten är med i något annat också
  NYKTERHET:    'nykterhet',     // nykterhets- eller drogkontroll — kastas alltid
  KAMERA:       'kamera',        // fartkameror finns redan i appen med rätt position
  OBEGRIPLIG:   'obegriplig',    // ingen typ hittad: frågor, skvaller, brus
  AVBLAST:      'avblast',       // "nu är dom borta" — sant men går inte att koppla
  LAG_TILLIT:   'lag-tillit',
  INGEN_PLATS:  'ingen-plats',
  FOR_GAMMALT:  'for-gammalt',   // varningen hade hunnit löpa ut innan vi såg den
  DUBBLETT:     'dubblett',
  OKAND_PLATS:  'okand-plats',   // platsen gick inte att geokoda
  GEOKOD_FEL:   'geokod-fel',    // nätverksfel — får försökas igen
};

/* ---- Telegrams svarsstrukturer --------------------------------------- */

/**
 * Adress till Telegrams bot-API. Bygger bara strängen — hämtar ingenting.
 *
 * Anropas bara på serversidan, av den som redan har token. Funktionen finns
 * här för att adressen ska se likadan ut oavsett vem som pollar, inte för att
 * appen någonsin ska röra den.
 */
export function telegramUrl(token, metod = 'getUpdates', params = {}) {
  const url = new URL(`https://api.telegram.org/bot${token}/${metod}`);
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    url.searchParams.set(k, Array.isArray(v) ? JSON.stringify(v) : String(v));
  }
  return url.toString();
}

/**
 * Plockar ut meddelandena ur ett getUpdates-svar.
 *
 * Kanalinlägg kommer som channel_post, inte message. Missar man det får man
 * en tom lista trots att det står folk och skriver i kanalen — det är det
 * vanligaste felet i hela bryggan. Redigerade inlägg tas med också: en admin
 * som rättar en felstavad gata ska ge en rapport, inte noll.
 *
 * @param {Object|Array} payload  getUpdates-svaret, dess result, en enskild
 *                                uppdatering, eller en lista av vad som helst
 *                                av det.
 * @returns {Array<{ msg:Object, updateId:number|null }>}
 */
export function plockaMeddelanden(payload) {
  const lista = Array.isArray(payload) ? payload
    : Array.isArray(payload?.result) ? payload.result
    : payload ? [payload] : [];

  const ut = [];
  for (const post of lista) {
    if (!post || typeof post !== 'object') continue;
    const msg = post.message || post.channel_post
             || post.edited_message || post.edited_channel_post
             || (post.chat || post.message_id ? post : null);
    if (!msg) continue;
    ut.push({ msg, updateId: Number.isFinite(post.update_id) ? post.update_id : null });
  }
  return ut;
}

/** Texten kan ligga i text (vanligt inlägg) eller caption (bild med text). */
export function textUr(msg) {
  return String(msg?.text || msg?.caption || '').trim();
}

/**
 * FNV-1a, 32 bitar. Samma funktion som i js/facebook.js, med flit — båda
 * bryggorna måste räkna fram samma textnyckel för samma text, annars blir
 * samma inlägg två rapporter när man byter väg in.
 */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * @returns {{ stabil:string, text:string, externalId:string,
 *             chatId:string, messageId:number|null }}
 *   stabil     — meddelandets egen identitet. Samma inlägg, alltid samma nyckel.
 *   text       — samma text i samma tidsfönster, oavsett meddelande-id.
 *   externalId — det som blir unikt i databasen.
 */
export function nycklarFor(msg, nu = Date.now()) {
  const chat = String(msg?.chat?.id ?? msg?.chat_id ?? 'okand');
  const id = msg?.message_id != null ? String(msg.message_id) : null;
  const h = hash(normalize(textUr(msg)));
  const fack = Math.floor(nu / DEDUP_FONSTER_MS).toString(36);
  const stabil = id ? `tg:${chat}:${id}` : `tx:${h}:${fack}`;
  return {
    stabil,
    text: `tx:${h}:${fack}`,
    externalId: stabil,
    chatId: chat,
    messageId: id ? Number(id) : null,
  };
}

/* ---- Tid -------------------------------------------------------------- */

/**
 * När skrevs det egentligen?
 *
 * Telegrams date är sekunder sedan epoch och gäller när meddelandet kom in i
 * kanalen. Är det vidarebefordrat är forward_date när originalet skrevs, och
 * det är den tidpunkten varningen ska räknas från — annars blir ett gammalt
 * inlägg färskt igen bara för att någon delade det vidare.
 *
 * Framtida tidsstämplar kapas mot nu. En klocka som går fel någonstans i
 * kedjan ska inte kunna ge en varning evigt liv.
 */
function skrivenNar(msg, nu) {
  const sek = msg?.forward_date
    ?? msg?.forward_origin?.date
    ?? msg?.date;
  if (!Number.isFinite(sek)) return nu;
  return Math.min(sek * 1000, nu);
}

/* ---- Position --------------------------------------------------------- */

/**
 * Vissa speglade inlägg bär en riktig kartnål (location) eller en plats
 * (venue). Då behövs ingen geokodning alls, och punkten är betydligt bättre
 * än ett gatunamn — men den räknas som "någon pekade på en karta", inte som
 * GPS. Det är inte rapportörens egen position; det är en nål någon satte ut.
 */
function positionUr(msg, plats) {
  const loc = msg?.venue?.location || msg?.location;
  if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) return null;
  return {
    lat: loc.latitude,
    lon: loc.longitude,
    label: String(msg?.venue?.title || plats || 'Utsatt plats').slice(0, LABEL_MAX),
    source: 'karta',
    typ: 'punkt',
  };
}

/**
 * Hur brett pekar platsnamnet?
 *
 * Kvalitetsgraderingen behöver veta skillnaden mellan "Stora gatan 14" och
 * "Bäckby". Utan det antas 1200 m osäkerhet på allt, och då tystas varenda
 * grupprapport — alltså precis de rapporter tjänsten finns för.
 *
 * Gissningen är avsiktligt grov och lutar åt det försiktiga hållet: när vi
 * inte vet blir det 'okand', vilket ger en STÖRRE antagen radie, inte mindre.
 * En bedömning som chansar åt det snäva hållet ljuger om hur säker den är.
 */
export function gissaGeokodTyp(plats, traff) {
  if (traff?.typ) return traff.typ;
  const t = normalize(traff?.label || plats || '');
  if (!t) return 'okand';
  /*
   * GENOMFARTSVÄGARNA PRÖVAS FÖRST, och ordningen är hela poängen.
   *
   * "riksväg 66" innehåller både en siffra och 'väg' följt av ordgräns, så
   * adressgrenen nedan svarade 'adress' på den — 40 m antagen radie på en väg
   * som går sex mil genom länet. Mätt: gissaGeokodTyp('riksväg 66') gav
   * 'adress' fram till 2026-08-23. 'led' ger 8 000 m i js/kvalitet.js, vilket
   * passerar platsHopplosOverM och gör att rapporten faller bort i stället för
   * att bli en självsäker nål på ett godtyckligt vägavsnitt.
   */
  // Även prefixade vägnamn (länsväg/landsväg/motorväg) och var som helst i
  // strängen, inte bara i början — "länsväg 250" föll förr till adressgrenen
  // (40 m) fast den är en genomfartsväg, precis samma fälla som "riksväg 66".
  if (/\b(e|rv|riksväg|länsväg|landsväg|motorväg|väg)\s?\d{1,3}\b/.test(t)) return 'led';
  if (/\d/.test(t) && /(gatan|vägen|gata|väg)\b/.test(t)) return 'adress';
  if (/(gatan|vägen|leden|gränd|torget|bron|rondell|rondellen|korsning|korsningen|motet|avfart|påfart|infart|rampen)/.test(t)) return 'vag';
  if (/^(västerås|sala|köping|arboga|fagersta|hallstahammar|surahammar|kungsör|norberg|skinnskatteberg|västmanland)$/.test(t)) return 'ort';
  return 'okand';
}

/* ---- Tolkning --------------------------------------------------------- */

/**
 * Ett Telegram-meddelande in — en rapport eller ett skäl ut.
 *
 * Ren funktion. Geokodningen görs INTE här, för den kräver nätet; tolkningen
 * lämnar ifrån sig platsfrasen och låter den som har nätet slå upp den.
 *
 * @param {Object} msg  Telegrams meddelandeobjekt (message eller channel_post)
 * @param {{ nu?:number, minTillit?:number, chatId?:string|number }} [val]
 * @returns {{ ok:false, skal:string, detalj?:string, nycklar:Object }
 *          |{ ok:true, typ:string, plats:string, tillit:number, text:string,
 *             skrivenAt:number, gallerTill:number, fordrojningS:number,
 *             position:Object|null, nycklar:Object }}
 */
export function tolkaMeddelande(msg, val = {}) {
  const { nu = Date.now(), minTillit = MIN_TILLIT, chatId = null } = val;
  const nycklar = nycklarFor(msg, nu);
  const nej = (skal, detalj) => ({ ok: false, skal, detalj, nycklar });

  if (chatId != null && String(msg?.chat?.id) !== String(chatId)) {
    return nej(SKAL.FEL_CHATT, String(msg?.chat?.id ?? ''));
  }

  const text = textUr(msg);
  if (!text) return nej(SKAL.TOM);

  // Först av allt, före parsern och oberoende av den: nykterhets- och
  // drogkontroller rapporteras aldrig. Det är produktregel nummer ett.
  //
  // Parsern gör redan den här kontrollen, och det här anropet är alltså
  // samma regel körd två gånger — inte en andra ordlista. Poängen är att
  // regeln ska sitta i den här filens första vägval också, så att en framtida
  // ändring i parsern som råkar flytta ordningen inte tyst öppnar en väg in
  // från gruppen. Den kan bara stoppa mer, aldrig släppa igenom mer.
  if (isSobrietyCheck(text)) return nej(SKAL.NYKTERHET);

  // platsKonvention: texten kommer ur gruppen, där konventionen är att man
  // skriver enbart när man ser en poliskontroll. Ett kort inlägg som bara
  // pekar ut en känd plats betyder därför polis där. Flaggan är AV som
  // standard och sätts aldrig för rösten eller appens knappar.
  const tolkat = parseReportText(text, { platsKonvention: true });

  if (tolkat?.intent === 'refused') {
    return nej(tolkat.reason === 'sobriety' ? SKAL.NYKTERHET : SKAL.KAMERA);
  }
  if (!tolkat) return nej(SKAL.OBEGRIPLIG);

  // "Nu är dom borta" är sann information, men vi vet inte vilken rapport den
  // gäller. Att gissa och släcka fel varning är värre än att låta den löpa ut
  // av sig själv om en halvtimme.
  if (tolkat.intent === 'clear') return nej(SKAL.AVBLAST);

  if (tolkat.confidence < minTillit) {
    return nej(SKAL.LAG_TILLIT, tolkat.confidence.toFixed(2));
  }

  const position = positionUr(msg, tolkat.place);

  // Utan plats finns ingen varning. En nål kan ersätta platsnamnet, men bara
  // en av de två får saknas.
  if (!tolkat.place && !position) return nej(SKAL.INGEN_PLATS);

  const skrivenAt = skrivenNar(msg, nu);
  const ttlMs = visningMinuter(tolkat.type) * 60000;
  const gallerTill = skrivenAt + ttlMs;

  // En varning som redan hunnit löpa ut ska aldrig läggas ut. Inlägget kan ha
  // legat i kanalen i timmar innan bryggan såg det, och en minut kvar är inte
  // värt en uppläsning.
  if (gallerTill <= nu + 60000) {
    return nej(SKAL.FOR_GAMMALT, new Date(skrivenAt).toISOString());
  }

  return {
    ok: true,
    typ: tolkat.type,
    plats: tolkat.place,
    tillit: tolkat.confidence,
    text,
    skrivenAt,
    gallerTill,
    // Mätt fördröjning mellan att inlägget skrevs och att vi läste det. Det
    // här är ett GOLV, inte sanningen: tiden från att bilen sågs till att
    // någon skrev om den går inte att veta. Men ett mätt golv är ärligare än
    // kvalitetslagrets antagande på 300 sekunder.
    fordrojningS: Math.round(clamp((nu - skrivenAt) / 1000, 0, 86400)),
    position,
    nycklar,
  };
}

/* ---- Rapportraden ----------------------------------------------------- */

/**
 * Färdig rad till public.reports.
 *
 * @param {Object} tolkning  resultatet från tolkaMeddelande med ok = true
 * @param {{lat:number, lon:number, label:string, source?:string, typ?:string}|null} traff
 *        geokodningens svar, eller null om tolkningen bar en egen position
 * @param {{ deviceId?:string, kalla?:string, id?:string }} [val]
 */
export function byggRapport(tolkning, traff, val = {}) {
  const { deviceId = BRYGGA_ENHET, kalla = KALLA, id = uid() } = val;
  const punkt = traff || tolkning.position;
  if (!punkt) throw new Error('byggRapport: ingen position');

  return {
    // Primärnyckeln är slumpad med flit. Vore den härledd ur meddelande-id:t
    // skulle en omkörning krocka på både id och external_id samtidigt, och
    // on conflict kan bara tyst hoppa över det ena. Med slumpat id är
    // external_id enda krocken, och det är den vi vill ska vara tyst.
    id,
    type: tolkning.typ,
    lat: punkt.lat,
    lon: punkt.lon,
    label: String(punkt.label || tolkning.plats).slice(0, LABEL_MAX),
    note: tolkning.text.slice(0, NOTE_MAX),
    source: kalla,
    device_id: deviceId,
    external_id: tolkning.nycklar.externalId,
    created_at: tolkning.skrivenAt,
    expires_at: tolkning.gallerTill,
    confirms: 1,
    denials: 0,

    // Kvalitetsfälten, se supabase/kvalitetsfalt.sql och js/kvalitet.js.
    //
    // De som är null är null med flit. NULL betyder "vet inte" och ska aldrig
    // tolkas som noll: vi vet ingenting om skribentens GPS eller fart, och
    // att skriva en nolla där hade sagt "perfekt noggrannhet, stillastående".
    parser_confidence: Number(tolkning.tillit.toFixed(3)),
    fordrojning_s: tolkning.fordrojningS,
    geokod: punkt.source || 'okand',
    geokod_typ: gissaGeokodTyp(tolkning.plats, punkt),
    // Radien MÄTT ur OSM-svaret när svaret bar en mätning, annars null så att
    // kvalitet.js får räkna fram den ur geokod_typ. Se radieFranSvar() i
    // js/geocode.js: boundingboxen får bara BREDDA, aldrig smalna av.
    geokod_radius_m: Number.isFinite(punkt?.radieM) ? punkt.radieM : null,
    gps_accuracy_m: null,
    fart_kmh: null,

    // De tre nedan är INTE kolumner i reports. De läses av
    // public.telegram_ta_emot() i supabase/telegram.sql: text_nyckel är den
    // andra dedupnyckeln (samma inlägg speglat igen med nytt id), de andra
    // två är till för revisionen i telegram_lasta.
    //
    // Raden går alltså till databasen genom RPC:n, inte genom en direkt
    // insert mot /rest/v1/reports — PostgREST hade avvisat hela raden med 400
    // för tre okända kolumner. Ska du någon gång skriva direkt: plocka bort
    // dem först, och kom ihåg att du då tappar textdedupen.
    text_nyckel: tolkning.nycklar.text,
    chat_id: tolkning.nycklar.chatId,
    message_id: tolkning.nycklar.messageId,
  };
}

/* ---- Omgången --------------------------------------------------------- */

/**
 * Kör en omgång meddelanden genom tolkning, geokodning och radbygge.
 *
 * Gör inget nätverksanrop själv. Geokodningen skickas in, och gör den inget
 * anrop heller (till exempel i ett test) rör funktionen aldrig nätet.
 *
 * @param {Object|Array} payload  getUpdates-svar, uppdateringar eller meddelanden
 * @param {{
 *   geokoda?: (plats:string) => Promise<{lat,lon,label,source?}|null>,
 *   sedda?: Set<string>,      dedup över anrop — skicka in samma mängd varje gång
 *   nu?: number, minTillit?: number, chatId?: string|number,
 *   deviceId?: string, kalla?: string
 * }} [val]
 * @returns {Promise<Object>} sammanfattning, se summeringText()
 */
export async function bearbeta(payload, val = {}) {
  const {
    geokoda = null,
    sedda = new Set(),
    nu = Date.now(),
    minTillit = MIN_TILLIT,
    chatId = null,
    deviceId = BRYGGA_ENHET,
    kalla = KALLA,
  } = val;

  const poster = plockaMeddelanden(payload);
  const summering = {
    lasta: poster.length,
    skapade: 0,
    dubbletter: 0,
    bortsorterade: {},
    rapporter: [],
    okandaPlatser: [],
    fel: [],
    sistaUpdateId: null,
  };

  const bort = skal => { summering.bortsorterade[skal] = (summering.bortsorterade[skal] || 0) + 1; };

  let retryFran = null;   // lägsta updateId vars geokodning föll på nätfel
  for (const { msg, updateId } of poster) {
    // Offset flyttas fram oavsett vad som händer med meddelandet. Ett inlägg
    // som inte går att hantera ska inte spelas om i evighet och blockera allt
    // som kom efter det. (Nätverksmissad geokodning är undantaget — den backas
    // efter loopen via retryFran.)
    if (updateId != null) {
      summering.sistaUpdateId = Math.max(summering.sistaUpdateId ?? updateId, updateId);
    }

    try {
      const tolkning = tolkaMeddelande(msg, { nu, minTillit, chatId });
      const { stabil, text: textNyckel } = tolkning.nycklar;

      // Dedup före allt annat arbete. Både meddelandets egen identitet och
      // textnyckeln räknas: det första fångar en omkörning av samma pollning,
      // det andra fångar samma inlägg speglat en gång till med nytt id.
      if (sedda.has(stabil) || sedda.has(textNyckel)) {
        summering.dubbletter++;
        continue;
      }

      if (!tolkning.ok) {
        bort(tolkning.skal);
        // Fel chatt märks inte som sedd — boten kan läggas till i rätt kanal
        // senare, och då ska inget vara tyst bortsorterat sedan innan.
        if (tolkning.skal !== SKAL.FEL_CHATT) { sedda.add(stabil); sedda.add(textNyckel); }
        continue;
      }

      let traff = tolkning.position;
      if (!traff) {
        if (typeof geokoda !== 'function') {
          throw new Error('bearbeta: geokoda-funktionen saknas — skicka in den, ' +
                          'modulen gör inga egna nätverksanrop.');
        }
        try {
          traff = await geokoda(tolkning.plats);
        } catch (e) {
          bort(SKAL.GEOKOD_FEL);
          summering.fel.push(`Geokodning av "${tolkning.plats}" misslyckades: ${e.message}`);
          // Nätverksfel ska få försöka igen. Men offset flyttades redan fram
          // ovan, så acken måste backas till FÖRE det här inlägget — annars
          // ackas det bort och Telegram skickar det aldrig igen (retry-avsikten
          // motsades tyst av offset-framflyttningen).
          if (updateId != null) retryFran = retryFran == null ? updateId : Math.min(retryFran, updateId);
          continue;
        }
        if (!traff || !Number.isFinite(traff.lat) || !Number.isFinite(traff.lon)) {
          bort(SKAL.OKAND_PLATS);
          if (!summering.okandaPlatser.includes(tolkning.plats)) {
            summering.okandaPlatser.push(tolkning.plats);
          }
          sedda.add(stabil); sedda.add(textNyckel);
          continue;
        }
      }

      summering.rapporter.push(byggRapport(tolkning, traff, { deviceId, kalla }));
      summering.skapade++;
      sedda.add(stabil); sedda.add(textNyckel);
    } catch (postFel) {
      // Saknad geokoda är ett konfigurationsfel, inte ett trasigt meddelande —
      // det ska INTE tystas per meddelande.
      if (/geokoda-funktionen saknas/.test(postFel.message || '')) throw postFel;
      // Ett enda trasigt meddelande (t.ex. en text som får parsern att kasta)
      // rev förr hela batchen och tappade allt som kom efter. Ta felet per
      // meddelande. Offset flyttades redan fram, så inlägget spelas inte om.
      bort('fel');
      summering.fel.push(`Meddelande kunde inte behandlas: ${postFel.message}`);
    }
  }

  // Backa acken till före första nätverksmissade geokodningen, så det inlägget
  // (och allt efter, som dedupas bort) hämtas om nästa pollning i stället för
  // att tyst tappas.
  if (retryFran != null && summering.sistaUpdateId != null) {
    summering.sistaUpdateId = Math.min(summering.sistaUpdateId, retryFran - 1);
  }

  return summering;
}

/** En rad på svenska att logga eller visa i en admin-vy. */
export function summeringText(s) {
  const bort = Object.values(s.bortsorterade).reduce((a, b) => a + b, 0);
  const delar = [
    `${s.lasta} meddelanden`,
    `${s.skapade} ${s.skapade === 1 ? 'varning' : 'varningar'}`,
  ];
  if (s.dubbletter) delar.push(`${s.dubbletter} redan inne`);
  if (bort) delar.push(`${bort} bortsorterade`);
  if (s.okandaPlatser.length) delar.push(`okänd plats: ${s.okandaPlatser.join(', ')}`);
  return delar.join(' · ');
}
