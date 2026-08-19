// Rapportera utan att släppa ratten.
//
// De flesta bilar har mediaknappar på ratten, och en tioknappars
// Bluetooth-dosa kostar hundralappen. Båda skickar samma sorts kommandon som
// en musikspelare tar emot, och webbläsaren kan fånga dem på två sätt:
//
//   Tangentbord   Många Bluetooth-dosor uppträder som tangentbord och skickar
//                 MediaTrackNext och liknande. Kostar ingenting att lyssna
//                 efter, så det är alltid på.
//
//   Media Session Rattknappar i bilen går via bilens mediaprofil. För att nå
//                 dem måste appen vara det som spelar ljud — och då tystnar
//                 Spotify. Det är ett verkligt val, inte en bugg, så den
//                 här vägen är avstängd från början och användaren får veta
//                 vad den kostar innan den slås på.
//
// Ett tryck ska göra en sak. Ingen meny, ingen bekräftelse, inget att titta på.

const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';

export const DEFAULT_BINDINGS = {
  nexttrack:     'report-police',
  previoustrack: 'confirm-nearest',
  play:          'toggle-mute',
  pause:         'toggle-mute',
  stop:          'none',
};

export const ACTIONS = {
  'report-police':   'Rapportera polis här',
  'report-control':  'Rapportera kontroll här',
  'report-camera':   'Rapportera fartkamera här',
  'report-unmarked': 'Rapportera civilbil här',
  'confirm-nearest': 'Bekräfta närmaste rapport',
  'clear-nearest':   'Markera närmaste som borta',
  'toggle-mute':     'Tysta / slå på ljud',
  'voice':           'Starta röstkommando',
  'save-clip':       'Spara dashcam-händelse',
  'none':            'Ingenting',
};

const KEY_MAP = {
  MediaTrackNext: 'nexttrack',
  MediaTrackPrevious: 'previoustrack',
  MediaPlayPause: 'play',
  MediaPlay: 'play',
  MediaPause: 'pause',
  MediaStop: 'stop',
  AudioVolumeUp: 'volumeup',
  AudioVolumeDown: 'volumedown',
};

export class RemoteControl extends EventTarget {
  constructor(bindings = {}) {
    super();
    this.bindings = { ...DEFAULT_BINDINGS, ...bindings };
    this.mediaSessionActive = false;
    this.audio = null;
    this.lastFireAt = 0;

    // Tangentbordsvägen är gratis och stör ingenting — alltid på
    addEventListener('keydown', e => {
      const action = KEY_MAP[e.key];
      if (!action) return;
      e.preventDefault();
      this.#fire(action, 'tangent');
    });
  }

  get supported() { return 'mediaSession' in navigator; }

  setBinding(button, action) {
    this.bindings[button] = action;
    this.dispatchEvent(new CustomEvent('change'));
  }

  /**
   * Ta över mediakontrollen. Kräver ett riktigt knapptryck för att få spela
   * ljud, och tystar annan uppspelning i bilen.
   */
  async enableMediaSession() {
    if (!this.supported || this.mediaSessionActive) return this.mediaSessionActive;

    this.audio = new Audio(SILENT_WAV);
    this.audio.loop = true;
    this.audio.volume = 0.0001;
    try {
      await this.audio.play();
    } catch {
      this.dispatchEvent(new CustomEvent('error', {
        detail: { message: 'Webbläsaren tillät inte uppspelning. Tryck på knappen igen.' },
      }));
      return false;
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Polisvakt — rattknappar aktiva',
      artist: 'Tryck nästa spår för att rapportera polis',
      album: 'Polisvakt Västmanland',
    });
    navigator.mediaSession.playbackState = 'playing';

    for (const b of ['nexttrack', 'previoustrack', 'play', 'pause', 'stop']) {
      try {
        navigator.mediaSession.setActionHandler(b, () => {
          this.#fire(b, 'ratt');
          // Håll sessionen vid liv så bilen inte tror att uppspelningen tog slut
          navigator.mediaSession.playbackState = 'playing';
          this.audio?.play?.().catch(() => {});
        });
      } catch { /* alla webbläsare stödjer inte alla knappar */ }
    }

    this.mediaSessionActive = true;
    this.dispatchEvent(new CustomEvent('change'));
    return true;
  }

  disableMediaSession() {
    if (!this.mediaSessionActive) return;
    for (const b of ['nexttrack', 'previoustrack', 'play', 'pause', 'stop']) {
      try { navigator.mediaSession.setActionHandler(b, null); } catch {}
    }
    try { navigator.mediaSession.playbackState = 'none'; } catch {}
    this.audio?.pause?.();
    this.audio = null;
    this.mediaSessionActive = false;
    this.dispatchEvent(new CustomEvent('change'));
  }

  #fire(button, via) {
    const action = this.bindings[button];
    if (!action || action === 'none') return;
    // Rattknappar studsar ibland — ignorera dubbeltryck inom en halv sekund
    const now = Date.now();
    if (now - this.lastFireAt < 500) return;
    this.lastFireAt = now;
    this.dispatchEvent(new CustomEvent('action', { detail: { action, button, via } }));
  }
}
