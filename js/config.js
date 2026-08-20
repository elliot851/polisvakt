// Central konfiguration.
//
// Tidigare fick varje användare klistra in Supabase-nycklar i inställningarna.
// Det fungerar när man testar själv men är orimligt för riktiga användare —
// nycklarna hör hemma i appen, inte hos föraren.
//
// Anon-nyckeln är byggd för att ligga öppet i klientkod. Den ger bara det som
// radsäkerhetsreglerna i supabase/schema.sql tillåter, och all känslig logik
// ligger i databasfunktioner. Det som aldrig får hamna här är service
// role-nyckeln.

export const CONFIG = {
  // Supabase -> Project Settings -> API
  supabaseUrl: 'https://livvehyqowmcafnisxho.supabase.co',
  supabaseAnonKey: 'sb_publishable_6Oz7vhMd2b-kWB_DVftsmg_VwclVG5Q',

  // Stripe Payment Link för 29 kr/mån
  stripePaymentLink: '',

  // Publik VAPID-nyckel för push. Tom = notiser när appen är stängd är
  // avstängda, och push.js säger då ifrån istället för att tyst misslyckas.
  // Genereras enligt docs/NOTISER.md.
  vapidPublicKey: 'BF0j2VrmOMgffbl4mHFLLpcPf_v_JqO52_ndLcZWXh2UQD1Ftj-8DCGSoyZoJqb7436gPwpOCPdV05lqB40Dkz0',

  // Appens namn på inloggningsskärmen och i delningar
  appName: 'Polisvakt',
  region: 'Västmanland',

  // Sätts vid varje bygge av package.ps1. Visas i appen så man ser att man
  // faktiskt kör den senaste versionen och inte en cachad gammal.
  version: '2026-08-20-43',
  builtAt: '2026-08-19T18:20:00+02:00',
};

/** "18 augusti 16:20" — när den här versionen byggdes. */
export function buildDate() {
  try {
    return new Date(CONFIG.builtAt).toLocaleString('sv-SE', {
      day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
    });
  } catch { return CONFIG.builtAt; }
}

/** Är backend konfigurerad, så konton och delning fungerar? */
export const hasBackend = () => !!(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);

/**
 * Aktuell inloggningstoken, delad av alla moduler som pratar med databasen.
 *
 * Det här är inte kosmetik. Serverfunktionerna avgör vem du är med auth.uid(),
 * som bara fylls i om anropet bär användarens JWT. Skickar vi anon-nyckeln
 * även för inloggade blir auth.uid() tom, och då faller hela skyddet mot att
 * rösta och radera i någon annans namn.
 *
 * Hålls synkron med flit — anropen ligger i varma kodvägar och ska inte
 * behöva bli asynkrona bara för att hämta en sträng.
 */
let accessToken = null;

export function setAccessToken(token) { accessToken = token || null; }

/** Bärartoken att skicka: användarens om hen är inloggad, annars anon. */
export const bearer = () => accessToken || CONFIG.supabaseAnonKey;

/** Standardhuvuden för alla databasanrop. */
export const apiHeaders = () => ({
  apikey: CONFIG.supabaseAnonKey,
  Authorization: `Bearer ${bearer()}`,
});

/**
 * Inställningarna får skriva över konfigurationen. Bra vid testning och
 * nödvändigt så länge appen inte har egna nycklar inbakade.
 */
export function applyOverrides(settings) {
  if (settings?.supaUrl) CONFIG.supabaseUrl = settings.supaUrl.replace(/\/$/, '');
  if (settings?.supaKey) CONFIG.supabaseAnonKey = settings.supaKey;
  if (settings?.paymentLink) CONFIG.stripePaymentLink = settings.paymentLink;
  return CONFIG;
}
