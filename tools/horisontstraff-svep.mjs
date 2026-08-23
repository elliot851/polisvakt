// Svepmätningen bakom horisontstraff-kommentarens platta-zon-tal (POANG_TAK-klämman).
// Kör:  node tools/horisontstraff-svep.mjs — mäts om när POANG_TAK eller klämman ändras.
globalThis.window = globalThis;
const P = await import('file:///C:/Users/ellio/OneDrive/Claude%20code%202GNDTN/polisvakt/js/plate.js');
const { horisontstraff, POANG_TAK, PLATTGRIND, MALSOK } = P;
const g = MALSOK.minPoang;
console.log('POANG_TAK', POANG_TAK, 'horisontTak', PLATTGRIND.horisontTak, 'minPoang', g);
console.log('hård lutning k =', ((PLATTGRIND.horisontTak - g) / (POANG_TAK - g)).toFixed(6));
// Jämnt svep [0; 2,4], steglängd 1e-5 => 240 000 steg. Platt steg = T(R_i+1) === T(R_i).
for (const hart of [true, false]) {
  let platta = 0, forsta = null, prev = null, ejVaxande = 0;
  for (let i = 0; i <= 240000; i++) {
    const R = i * 1e-5;
    const T = horisontstraff(R, hart);
    if (prev !== null) {
      if (T === prev) { platta++; if (forsta === null) forsta = R; }
      else if (T < prev) ejVaxande++;
    }
    prev = T;
  }
  console.log((hart?'HÅRT':'MJUKT')+' band: platta steg', platta, 'första platta vid R =', forsta, 'minskande steg', ejVaxande);
}
