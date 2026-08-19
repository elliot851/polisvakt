// Guide för "lägg till på hemskärmen".
//
// Poängen: appen är en hemsida, men ska kännas som en app. Sparad på
// hemskärmen startar den i helskärm utan adressfält, och röst, GPS och
// kamera fungerar likadant.
//
// Instruktionerna skiljer sig rejält mellan iPhone och Android, och Samsung
// Internet har en egen meny som inte liknar Chromes. Därför får användaren
// välja telefon istället för att vi gissar — vi förväljer bara det vi tror.

const KEY = 'pv.install.v1';

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.navigator.standalone === true;
}

export function detectPlatform() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
    return 'iphone';
  }
  if (/SamsungBrowser/i.test(ua) || /SM-|Samsung/i.test(ua)) return 'samsung';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

export const GUIDES = {
  iphone: {
    title: 'iPhone',
    icon: '',
    requiresSafari: true,
    steps: [
      { icon: '🧭', text: 'Öppna sidan i <b>Safari</b>. Chrome på iPhone fungerar också, men Safari är säkrast.' },
      { icon: '⬆️', text: 'Tryck på <b>Dela</b>-knappen — fyrkanten med pilen uppåt, längst ner i mitten.' },
      { icon: '➕', text: 'Skrolla ner i listan och tryck <b>Lägg till på hemskärmen</b>.' },
      { icon: '✅', text: 'Tryck <b>Lägg till</b> uppe till höger. Ikonen hamnar på hemskärmen.' },
      { icon: '🎙️', text: 'Öppna appen från ikonen. Första gången frågar den om <b>plats</b>, <b>mikrofon</b> och <b>kamera</b> — svara Tillåt, annars kan den inte varna eller filma.' },
    ],
    note: 'iPhone tillåter inte röstigenkänning i webbläsaren. Väckningsordet "Hej vakt" fungerar därför inte på iPhone — där rapporterar du med tryck-och-tala-knappen istället. Uppläsningen av varningar fungerar som vanligt.',
  },
  samsung: {
    title: 'Samsung',
    icon: '',
    steps: [
      { icon: '🌐', text: 'Öppna sidan i <b>Samsung Internet</b> eller <b>Chrome</b>.' },
      { icon: '☰', text: 'I Samsung Internet: tryck på <b>menyn</b> (tre streck) längst ner till höger.<br>I Chrome: tryck på <b>tre punkter</b> uppe till höger.' },
      { icon: '➕', text: 'Välj <b>Lägg till sida på</b> → <b>Startsida</b>.<br>I Chrome heter det <b>Installera app</b> eller <b>Lägg till på startskärmen</b>.' },
      { icon: '✅', text: 'Bekräfta med <b>Lägg till</b>.' },
      { icon: '🎙️', text: 'Starta appen från ikonen och svara <b>Tillåt</b> på plats, mikrofon och kamera.' },
    ],
    note: 'På Samsung fungerar väckningsordet "Hej vakt" i Chrome. Samsung Internet stödjer inte röstigenkänning fullt ut — använd Chrome om du vill styra appen med rösten.',
  },
  android: {
    title: 'Android',
    icon: '',
    steps: [
      { icon: '🌐', text: 'Öppna sidan i <b>Chrome</b>.' },
      { icon: '⋮', text: 'Tryck på <b>tre punkter</b> uppe till höger.' },
      { icon: '➕', text: 'Välj <b>Installera app</b> eller <b>Lägg till på startskärmen</b>.' },
      { icon: '✅', text: 'Bekräfta med <b>Installera</b>.' },
      { icon: '🎙️', text: 'Starta appen från ikonen och svara <b>Tillåt</b> på plats, mikrofon och kamera.' },
    ],
    note: 'Chrome på Android har fullt stöd för allt i appen, inklusive väckningsordet "Hej vakt".',
  },
  desktop: {
    title: 'Dator',
    icon: '',
    steps: [
      { icon: '🖥️', text: 'Appen är byggd för mobil i bil, men fungerar i Chrome eller Edge på datorn för att testa.' },
      { icon: '➕', text: 'Klicka på <b>installationsikonen</b> i adressfältet för att köra den som ett eget fönster.' },
    ],
    note: 'GPS på en dator är ofta grov. Testa hellre i telefonen.',
  },
};

/** Chrome/Android ger oss en riktig installationsprompt — fånga upp den. */
export class InstallPrompt extends EventTarget {
  constructor() {
    super();
    this.deferred = null;
    addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      this.deferred = e;
      this.dispatchEvent(new CustomEvent('available'));
    });
    addEventListener('appinstalled', () => {
      this.deferred = null;
      markSeen();
      this.dispatchEvent(new CustomEvent('installed'));
    });
  }

  get available() { return !!this.deferred; }

  async prompt() {
    if (!this.deferred) return false;
    this.deferred.prompt();
    const { outcome } = await this.deferred.userChoice;
    this.deferred = null;
    return outcome === 'accepted';
  }
}

export function hasSeenGuide() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}
export function markSeen() {
  try { localStorage.setItem(KEY, '1'); } catch {}
}
export function resetGuide() {
  try { localStorage.removeItem(KEY); } catch {}
}

/** Ska guiden visas automatiskt? Bara i mobilwebbläsare, en gång. */
export function shouldAutoShow() {
  if (isStandalone()) return false;
  if (hasSeenGuide()) return false;
  return ['iphone', 'samsung', 'android'].includes(detectPlatform());
}
