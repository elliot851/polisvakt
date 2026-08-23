// Mätprotokoll för delsträngsgrinden (fynd: delsträngar kan mynta stabila fel nummer).
// Kör:  node tools/delstrang-matning.mjs   (portabel node i LOCALAPPDATA/nodejs-portable)
// Mäts om vid varje ändring i tolkaRatext/rattaSex/Rostrakning. Facit i NIGHT_LOG 2026-08-23.
// Mätning fynd 4 — körs mot den RIKTIGA modulen, inte en kopia.
globalThis.window = globalThis;
const P = await import('file:///C:/Users/ellio/OneDrive/Claude%20code%202GNDTN/polisvakt/js/plate.js');
const { normaliseraPlat, tolkaRatext, PLAT_RE, OCR_ALFABET, Rostrakning, ROST } = P;

// De 22 facitnumren ur matning.html (unika).
const FACIT = ['YBK70U','FAP18M','UTX153','CHK49S','ZPD710','XTU097','XWE623',
  'ABU773','GRE101','EZN242','HNL210','EEL62J','RUR017','YDR167','YDR168',
  'URK924','NWA780','NJK447','HET69A','ABC123','MLB84A','YAA120'];
for (const f of FACIT) if (normaliseraPlat(f) !== f) console.log('FACIT EJ GILTIG:', f, normaliseraPlat(f));

const AL = OCR_ALFABET; // 33 tecken
console.log('alfabet', AL.length);

// M1: en insättning, varje position, varje tecken, varje facitnummer.
let ande = {ratt:0, fel:0, tyst:0}, mitt = {ratt:0, fel:0, tyst:0};
for (const f of FACIT) {
  for (let pos = 0; pos <= 6; pos++) {
    for (const c of AL) {
      const s = f.slice(0,pos) + c + f.slice(pos);
      const r = normaliseraPlat(s);
      const hink = (pos === 0 || pos === 6) ? ande : mitt;
      if (r === f) hink.ratt++;
      else if (r) hink.fel++;
      else hink.tyst++;
    }
  }
}
console.log('ÄNDE  ', ande, 'summa', ande.ratt+ande.fel+ande.tyst);
console.log('MITTEN', mitt, 'summa', mitt.ratt+mitt.fel+mitt.tyst);

// M2: slumpbrusets acceptansyta per längd.
//
// RNG:n var förut (seed * 1103515245 + 12345) & 0x7fffffff. Den ser ut som
// klassisk LCG men är trasig i JavaScript: produkten spränger 2^53 och
// avrundas INNAN &-maskningen, så fördelningen blir skev. Protokollet skrev
// då 24,672/31,192/19,182 % medan sanningen (likformig crypto-RNG) är
// 24,12/30,76/18,48 — och kommentaren i js/plate.js som hänvisar hit hade
// blivit "rättad" åt fel håll vid nästa ommätning. mulberry32 håller sig i
// 32 bitar via Math.imul och är deterministisk, så körningarna förblir
// reproducerbara med samma frö.
let seed = 424242;
const rnd = () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
for (const L of [6,7,8]) {
  const N = 200000; let acc = 0;
  for (let i = 0; i < N; i++) {
    let s = ''; for (let j = 0; j < L; j++) s += AL[Math.floor(rnd()*AL.length)];
    if (normaliseraPlat(s)) acc++;
  }
  console.log('BRUS längd', L, ':', (100*acc/N).toFixed(3), '% accepterat av', N);
}

// M3: rösträkningen — kan ett delsträngsnummer någonsin annonseras?
// a) systematisk mitteninsättning: samma felhash varje varv, exakt:false.
{
  const rost = new Rostrakning({ fonsterMs: 2500, varvMs: 700 });
  let nu = Date.now(), klarNagonsin = false;
  for (let i = 0; i < 200; i++) {
    const r = rost.rosta('spar1', 'FELHASH', 95, { krav: 2, nu, exakt: false });
    if (r.klar) klarNagonsin = true;
    nu += 700;
  }
  console.log('SYSTEMATISK DELSTRÄNG, 200 varv à 700 ms, säkerhet 95: klar =', klarNagonsin);
}
// b) delsträngar + EN sexteckenläsning på samma nummer: ska kunna annonseras.
{
  const rost = new Rostrakning({ fonsterMs: 2500, varvMs: 700 });
  let nu = Date.now(), klarVid = null;
  for (let i = 0; i < 20; i++) {
    const exakt = (i === 3);   // en enda hel läsning
    const r = rost.rosta('spar2', 'RATTHASH', 90, { krav: 2, nu, exakt });
    if (r.klar && klarVid == null) klarVid = i + 1;
    nu += 700;
  }
  console.log('DELSTRÄNGAR + 1 EXAKT (varv 4): klar vid varv', klarVid);
}
// c) oförändrat beteende för enbart exakta läsningar (bakåtkompatibilitet,
//    samma protokoll som matning.htmls steg 3).
{
  const rost = new Rostrakning({ fonsterMs: 2500, varvMs: 700 });
  let nu = Date.now(), n = 0, klar = false;
  while (n < 10 && !klar) { n++; klar = rost.rosta(1, 'h', 0, { krav: 2, nu }).klar; nu += 700; }
  console.log('ENDAST EXAKTA, säkerhet 0 (matning-protokollet): klar efter', klar ? n : 'aldrig');
  const rost2 = new Rostrakning({ fonsterMs: 2500, varvMs: 700 });
  nu = Date.now(); n = 0; klar = false;
  while (n < 10 && !klar) { n++; klar = rost2.rosta(1, 'h', 91, { krav: 2, nu }).klar; nu += 700; }
  console.log('ENDAST EXAKTA, säkerhet 91: klar efter', klar ? n : 'aldrig');
}

// M4: de fem dokumenterade delsträngsräddningarna ur bänkens råtexter.
for (const [ra, vantat] of [['YBK70UN','YBK70U'],['FAP18MJ','FAP18M'],
  ['1ZPD710','ZPD710'],['JURK924','URK924'],['AABC123','ABC123'],['ABU2773',null]]) {
  const t = tolkaRatext(ra);
  console.log('RÅTEXT', ra, '->', t.plat, 'exaktSex', t.exaktSex,
              t.plat === vantat ? 'OK' : 'AVVIKER (väntat ' + vantat + ')');
}
