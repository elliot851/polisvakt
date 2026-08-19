// Roadmap som en kedja.
//
// Rötterna längst ner är grunden som allt annat står på. Uppåt växer det mot
// det som inte finns än. Varje färdig länk är guld, den vi jobbar på pulserar,
// och det som ligger framför är matt tills det är gjort.
//
// Poängen är inte dekoration. En användare som ser att appen växer stannar
// kvar längre än en som ser en app som verkar färdig och död — och Elliot ser
// själv var vi är utan att fråga.
//
// Status: 'done' | 'now' | 'next' | 'later' | 'never'

export const MILESTONES = [
  /* ---- Rötterna: grunden ---- */
  {
    id: 'karta', status: 'done', phase: 'Grunden',
    title: 'Karta och position',
    body: 'Mörk karta, din position med färdriktning, allt i närheten sorterat efter avstånd.',
  },
  {
    id: 'kameror', status: 'done', phase: 'Grunden',
    title: '136 fartkameror',
    body: 'Hela Västmanland, med mätriktning — varnar bara när du kör mot dem, aldrig när du kört förbi.',
  },
  {
    id: 'rost', status: 'done', phase: 'Grunden',
    title: 'Röstvarningar på svenska',
    body: 'Avstånd, klockriktning och hur gammal uppgiften är. Musiken dämpas som ett trafikmeddelande.',
  },
  {
    id: 'hastighet', status: 'done', phase: 'Grunden',
    title: 'Hastighetsgräns för vägen',
    body: 'Hämtad från OpenStreetMap. Siffran blir gul över gränsen, röd klart över.',
  },

  /* ---- Stammen: det som gör den till en app ---- */
  {
    id: 'konton', status: 'done', phase: 'Stammen',
    title: 'Konton och delade rapporter',
    body: 'Logga in med användarnamn eller e-post. Din rapport når alla andra i länet.',
  },
  {
    id: 'dashcam', status: 'done', phase: 'Stammen',
    title: 'Dashcam med krockdetektering',
    body: 'Filmar framåt med ljud, loopar, låser klippet automatiskt vid en smäll.',
  },
  {
    id: 'omrade', status: 'done', phase: 'Stammen',
    title: 'Bevakningsområde och rutt',
    body: 'Radie, stad, län — eller varningar längs hela vägen dit du ska.',
  },
  {
    id: 'monster', status: 'done', phase: 'Stammen',
    title: 'Historik och mönster',
    body: 'Var polisen brukar stå, och när. Blir bättre ju längre appen används.',
  },
  {
    id: 'guide', status: 'done', phase: 'Stammen',
    title: 'Introduktionsguide och självuppdatering',
    body: 'Appen förklarar sig själv och håller sig aktuell utan att du gör något.',
  },
  {
    id: 'vakthund', status: 'done', phase: 'Stammen',
    title: 'Säger till när den slutat varna',
    body: 'Tystnad betyder "fritt fram". Tappas GPS:en eller servern säger appen det högt — och när det fungerar igen.',
  },
  {
    id: 'kvalitet', status: 'done', phase: 'Stammen',
    title: 'Rapporter som går att lita på',
    body: 'Osäkra rapporter sägs som referat, inte som fakta. En falsk varning kostar mer än en missad.',
  },
  {
    id: 'rotation', status: 'done', phase: 'Stammen',
    title: 'Kartan vrids åt färdriktningen',
    body: 'Som i Waze. Höger på skärmen är höger genom vindrutan.',
  },
  {
    id: 'varme', status: 'done', phase: 'Stammen',
    title: 'Märker när telefonen inte hinner med',
    body: 'Sänker videokvaliteten istället för att låta inspelningen tyst stanna.',
  },

  /* ---- Grenarna: pågår ---- */
  {
    id: 'facebook', status: 'now', phase: 'Pågår',
    title: 'Facebook-gruppen live',
    body: 'Tolkningen är klar och testad. Kvar: kopplingen som hämtar inläggen från "Här står polisen".',
  },
  {
    id: 'betalning', status: 'now', phase: 'Pågår',
    title: 'Betalning',
    body: 'Tre nivåer finns i appen. Kvar: Stripe, så knappen faktiskt tar betalt.',
  },

  /* ---- Kronan: närmast ---- */
  {
    id: 'hallare', status: 'next', phase: 'Närmast',
    title: 'Mobilhållaren',
    body: 'Magnetfäste så bakkameran är fri. Källa i Kina, svenskt lager, egen förpackning.',
  },
  {
    id: 'notiser', status: 'now', phase: 'Pågår',
    title: 'Påminnelser när du brukar köra',
    body: 'Appen lär sig dina tider och koden är på plats. Kvar: servernyckeln som gör att notisen når dig när appen är stängd.',
  },
  {
    id: 'grupper', status: 'done', phase: 'Stammen',
    title: 'Grupper',
    body: 'Åkeriet, körskolan, kompisgänget. Egna delade rapporter som ingen utanför gruppen ser.',
  },

  /* ---- Toppen: längre fram ---- */
  {
    id: 'vinter', status: 'done', phase: 'Stammen',
    title: 'Vinterläge',
    body: 'Halkvarning från SMHI och viltstråk i skymningen. Appen är körsäkerhet nu, inte bara polis.',
  },
  {
    id: 'native', status: 'later', phase: 'Längre fram',
    title: 'Riktig app i App Store',
    body: 'Krävs för bakgrundskörning och riktiga notiser. Webbappen bevisar att folk vill ha det först.',
  },
  {
    id: 'norden', status: 'later', phase: 'Längre fram',
    title: 'Norge, Danmark, Finland',
    body: 'Kameradata, platsnamn och språk ligger redan i separata filer.',
  },

  /* ---- Det som medvetet inte byggs ---- */
  {
    id: 'regnummer', status: 'never', phase: 'Byggs inte',
    title: 'Register över civila polisbilar',
    body: 'Permanent katalog över enskilda tjänstemäns fordon. "Civil"-rapporten finns istället, och går ut efter 30 minuter.',
  },
  {
    id: 'anpr', status: 'never', phase: 'Byggs inte',
    title: 'Automatisk skyltavläsning',
    body: 'Massinsamling av registreringsnummer på alla du kör förbi. Fungerar dessutom inte i en mobilwebbläsare.',
  },
  {
    id: 'nykterhet', status: 'never', phase: 'Byggs inte',
    title: 'Nykterhetskontroller',
    body: 'Att varna för dem hjälper någon att köra vidare full. Appen vägrar sådana rapporter.',
  },
];

export const STATUS = {
  done:  { label: 'Klart',       cls: 'done' },
  now:   { label: 'Pågår nu',    cls: 'now' },
  next:  { label: 'Närmast',     cls: 'next' },
  later: { label: 'Längre fram', cls: 'later' },
  never: { label: 'Byggs inte',  cls: 'never' },
};

/** Hur långt vi kommit, räknat på det som faktiskt ska byggas. */
export function progress() {
  const real = MILESTONES.filter(m => m.status !== 'never');
  const done = real.filter(m => m.status === 'done').length;
  return { done, total: real.length, percent: Math.round((done / real.length) * 100) };
}

/**
 * Rita kedjan. Rötterna hamnar längst ner, så listan vänds — man läser
 * uppifrån och ser framtiden först, men ögat följer guldet nedåt till det
 * som redan står stadigt.
 */
export function renderChain(el) {
  if (!el) return;
  const p = progress();
  const items = [...MILESTONES].reverse();

  el.innerHTML =
    `<div class="rm-progress">
       <div class="rm-bar"><span style="width:${p.percent}%"></span></div>
       <div class="rm-count">${p.done} av ${p.total} klara</div>
     </div>` +
    items.map((m, i) => {
      const s = STATUS[m.status] || STATUS.later;
      const prev = items[i + 1];
      // Länken mellan två noder är guld bara när båda är klara
      const linkGold = m.status === 'done' && prev && prev.status === 'done';
      return `
        <div class="rm-node ${s.cls}">
          <div class="rm-spine">
            <span class="rm-dot"></span>
            ${prev ? `<span class="rm-link ${linkGold ? 'gold' : ''}"></span>` : ''}
          </div>
          <div class="rm-body">
            <div class="rm-head">
              <b>${m.title}</b>
              <span class="rm-tag">${s.label}</span>
            </div>
            <p>${m.body}</p>
          </div>
        </div>`;
    }).join('');
}
