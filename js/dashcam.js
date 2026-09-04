// Dashcam.
//
// Båda kamerorna ritas in i en canvas som sedan spelas in. Det ger tre saker
// på köpet: digital zoom som fungerar även på iPhone (där webbläsaren inte
// släpper fram den optiska), bild-i-bild av fram- och bakkamera i samma fil,
// och en layout som kan byta mellan stående och liggande utan att inspelningen
// bryts.
//
// Inspelningen delas i segment (default 2 min). Segmenten läggs i IndexedDB
// och de äldsta raderas automatiskt när bufferten är full — som en riktig
// dashcam. Trycker du "Spara händelse" låses segmenten runt den tidpunkten så
// de överlever loopen.
//
// Viktig begränsning, värd att vara ärlig om: webbläsare stoppar kameran när
// appen hamnar i bakgrunden eller skärmen släcks. Wake Lock håller skärmen
// tänd, men appen måste ligga framme under körningen.

const DB_NAME = 'pv-dashcam';
const DB_VERSION = 1;
const STORE = 'clips';

/* ---------------- IndexedDB ---------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('startedAt', 'startedAt');
        s.createIndex('locked', 'locked');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(store)).then(v => { out = v; }).catch(reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const idbGetAll = () => tx('readonly', s => new Promise(res => {
  const r = s.getAll();
  r.onsuccess = () => res(r.result || []);
}));

const idbPut = clip => tx('readwrite', s => new Promise(res => {
  const r = s.put(clip);
  r.onsuccess = () => res(r.result);
}));

const idbDelete = id => tx('readwrite', s => s.delete(id));

/* ---------------- Kodek ---------------- */

function pickMime() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',   // Safari / iOS
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const m of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
  }
  return '';
}

export const dashcamSupported = !!(
  navigator.mediaDevices?.getUserMedia &&
  window.MediaRecorder &&
  HTMLCanvasElement.prototype.captureStream
);

/* ---------------- Dashcam ---------------- */

export class Dashcam extends EventTarget {
  constructor() {
    super();
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false });

    this.rearStream = null;      // bakkameran, filmar framåt genom vindrutan
    this.frontStream = null;     // frontkameran, filmar in i kupén
    this.audioStream = null;
    this.rearVideo = this.#makeVideo();
    this.frontVideo = this.#makeVideo();

    this.recorder = null;
    this.recording = false;
    this.segmentChunks = [];
    this.segmentStart = 0;
    this.rafId = null;
    this.drawTimer = null;
    this.segmentTimer = null;
    this.wakeLock = null;

    this.settings = {
      orientation: 'portrait',   // 'portrait' | 'landscape'
      dual: false,               // av som standard: bakkameran framåt är det som gäller i bil
      pip: 'bottom-right',       // var kupébilden hamnar
      audio: true,
      zoomRear: 1,               // 1.0 - 5.0
      zoomFront: 1,
      quality: 'high',           // low | medium | high
      segmentSeconds: 120,
      bufferMinutes: 30,
      stamp: true,               // brännmärk tid + hastighet i bilden
    };

    this.overlay = { speedKmh: null, lat: null, lon: null };
    this.dualActive = false;
    this.lastError = null;
  }

  /**
   * Video-elementen MÅSTE sitta i dokumentet.
   *
   * Ett löst element som aldrig fästs i sidan avkodar inga bildrutor i Safari
   * och i flera Android-webbläsare — drawImage ritar då bara svart, utan att
   * något kastar fel. Det är exakt så en trasig dashcam ser ut: allt verkar
   * fungera, filen blir stor, och bilden är kolsvart.
   *
   * De får inte heller gömmas med display:none eller visibility:hidden, av
   * samma skäl. Därför ligger de kvar i sidan, en enda pixel stora och
   * genomskinliga, bakom canvasen.
   */
  #makeVideo() {
    const v = document.createElement('video');
    v.playsInline = true; v.muted = true; v.autoplay = true; v.defaultMuted = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('muted', '');
    v.setAttribute('autoplay', '');
    v.style.cssText =
      'position:absolute;left:0;top:0;width:2px;height:2px;opacity:0.01;' +
      'pointer-events:none;z-index:-1;object-fit:cover;';
    return v;
  }

  /** Fäst video-elementen i sidan, bredvid canvasen. */
  #attachVideos() {
    const host = this.canvas.parentNode || document.body;
    for (const v of [this.rearVideo, this.frontVideo]) {
      if (!v.isConnected) host.appendChild(v);
    }
  }

  /**
   * Vänta tills videon faktiskt levererar en bildruta, inte bara tills den
   * säger sig vara redo. readyState ljuger på vissa telefoner.
   */
  #waitForFrame(video, timeoutMs = 6000) {
    return new Promise(resolve => {
      let done = false;
      let poll = null;
      const finish = ok => {
        if (done) return;
        done = true;
        clearTimeout(timer); clearInterval(poll);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);

      const check = () => {
        if (done) return;
        // currentTime räcker inte som enda kriterium: en del webbläsare
        // rapporterar noll ett tag efter att bilden faktiskt börjat komma.
        // readyState 2 betyder att det finns data för den aktuella rutan.
        if (video.videoWidth > 0 && video.videoHeight > 0 &&
            (video.currentTime > 0 || video.readyState >= 2)) {
          finish(true);
        }
      };

      // Pollning med timer, INTE requestAnimationFrame.
      //
      // Det här var en riktig bugg: både rAF och requestVideoFrameCallback
      // ligger stilla när sidan inte ritas upp. Videoelementen är dessutom
      // två pixlar stora med opacity 0.01 för att inte synas, och ett
      // element som webbläsaren inte komponerar får aldrig något
      // requestVideoFrameCallback. Resultatet blev att kameran kunde leverera
      // trettio bilder i sekunden medan appen påstod "Kameran startade men
      // skickade ingen bild" — och vägrade spela in.
      //
      // En timer strypts till ungefär en gång i sekunden i bakgrunden, men
      // den slutar aldrig gå. Långsamt är oändligt mycket bättre än aldrig.
      poll = setInterval(check, 100);
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(() => finish(true));
      }
      check();
    });
  }

  /**
   * Titta faktiskt på bilden innan vi påstår att kameran filmar. Vi läser av
   * ett rutnät av punkter i canvasen — är allt nästan svart och utan variation
   * är det ingen bild, oavsett vad webbläsaren rapporterar.
   */
  #canvasHasPicture() {
    try {
      const probe = document.createElement('canvas');
      probe.width = 32; probe.height = 32;
      const pctx = probe.getContext('2d', { willReadFrequently: true });
      pctx.drawImage(this.canvas, 0, 0, 32, 32);
      const d = pctx.getImageData(0, 0, 32, 32).data;

      let sum = 0, min = 255, max = 0;
      for (let i = 0; i < d.length; i += 4) {
        const lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
        sum += lum;
        if (lum < min) min = lum;
        if (lum > max) max = lum;
      }
      const avg = sum / (d.length / 4);
      // En riktig bild har antingen ljusstyrka eller kontrast. En svart ruta
      // har varken. Tröskeln är lågt satt så nattkörning inte flaggas.
      return avg > 6 || (max - min) > 18;
    } catch {
      return true;   // kan vi inte mäta, anta att det är bra och låt inspelningen fortsätta
    }
  }

  get resolution() {
    const q = this.settings.quality;
    const long = q === 'high' ? 1920 : q === 'medium' ? 1280 : 854;
    const short = q === 'high' ? 1080 : q === 'medium' ? 720 : 480;
    return this.settings.orientation === 'portrait'
      ? { w: short, h: long }
      : { w: long, h: short };
  }

  get bitrate() {
    return { high: 6_000_000, medium: 3_000_000, low: 1_200_000 }[this.settings.quality];
  }

  /* ---- Kamerastart ---- */

  async start() {
    if (this.recording) return;
    this.lastError = null;
    this.mode = 'canvas';

    const res = this.resolution;
    const vc = {
      width:  { ideal: Math.max(res.w, res.h) },
      height: { ideal: Math.min(res.w, res.h) },
      frameRate: { ideal: 30, max: 30 },
    };

    // Videoelementen först i sidan, sedan strömmen. Omvänd ordning gör att
    // vissa telefoner missar första bildrutan.
    this.#attachVideos();

    // Bakkameran filmar framåt genom vindrutan. Den är huvudbilden och måste
    // finnas — utan den är det ingen dashcam.
    // exact framför ideal: med ideal väljer vissa telefoner glatt
    // selfiekameran, och då filmar man sitt eget ansikte hela resan.
    try {
      this.rearStream = await navigator.mediaDevices.getUserMedia({
        video: { ...vc, facingMode: { exact: 'environment' } }, audio: false,
      });
    } catch {
      this.rearStream = await navigator.mediaDevices.getUserMedia({
        video: { ...vc, facingMode: 'environment' }, audio: false,
      });

      // Reservvägen ovan är ett önskemål, inte ett krav — telefonen får
      // lämna vilken kamera som helst, och en del lämnar glatt selfiekameran.
      // Då hade appen filmat förarens ansikte hela resan och kallat det
      // dashcam. Hellre ett tydligt fel än en oanvändbar inspelning man
      // upptäcker först efteråt.
      if (this.#isFrontFacing(this.rearStream.getVideoTracks()[0])) {
        this.#stopStream(this.rearStream);
        this.rearStream = null;
        throw new Error(
          'Telefonen gav selfiekameran istället för den bakre. ' +
          'Dashcamen filmar framåt genom vindrutan och kan inte använda den. ' +
          'Stäng andra appar som använder kameran och försök igen.'
        );
      }
    }
    this.rearVideo.srcObject = this.rearStream;
    await this.rearVideo.play().catch(() => {});

    const gotFrame = await this.#waitForFrame(this.rearVideo);
    if (!gotFrame) {
      this.#stopStream(this.rearStream); this.rearStream = null;
      throw new Error('Kameran startade men skickade ingen bild.');
    }
    this.#emit('note', {
      text: `Kamera igång: ${this.rearVideo.videoWidth}×${this.rearVideo.videoHeight}`,
    });

    // Kupébilden är ett bonusspår. Många telefoner vägrar två kameror
    // samtidigt — då kör vi vidare med bara den ena.
    this.dualActive = false;
    if (this.settings.dual) {
      try {
        this.frontStream = await navigator.mediaDevices.getUserMedia({
          // exact, inte ideal. Kupéspåret ska visa kupén. Med ideal kan
          // telefonen lämna bakkameran igen, och då spelas vägen framför in
          // två gånger medan kupén inte filmas alls.
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: { exact: 'user' } },
          audio: false,
        });
        this.frontVideo.srcObject = this.frontStream;
        await this.frontVideo.play().catch(() => {});
        await new Promise(r => setTimeout(r, 400));
        // Kollar att bakkameran fortfarande lever — på iPhone stängs den ofta
        const rearTrack = this.rearStream.getVideoTracks()[0];
        if (rearTrack.readyState === 'live' && this.frontStream.getVideoTracks()[0].readyState === 'live') {
          this.dualActive = true;
        } else {
          this.#stopStream(this.frontStream); this.frontStream = null;
          this.#emit('note', { text: 'Telefonen klarar bara en kamera i taget. Spelar in framåt.' });
        }
      } catch {
        this.frontStream = null;
        this.#emit('note', { text: 'Kupékameran gick inte att starta. Spelar in framåt.' });
      }
    }

    if (this.settings.audio) {
      try {
        this.audioStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
        });
      } catch {
        this.audioStream = null;
        this.#emit('note', { text: 'Ljudet kunde inte startas. Spelar in utan ljud.' });
      }
    }

    this.#applyNativeZoom();
    this.#resizeCanvas();
    await this.#fitBufferToQuota();
    this.#loop();

    // Rita några rutor och kontrollera sedan att det faktiskt kom bild.
    // Utan det här steget spelar appen glatt in en kolsvart film och säger
    // att allt är bra — det värsta som kan hända med en dashcam.
    await new Promise(r => setTimeout(r, 500));
    if (!this.#canvasHasPicture()) {
      await new Promise(r => setTimeout(r, 700));
      if (!this.#canvasHasPicture()) {
        // Canvas-vägen ger ingen bild på den här telefonen. Spela in
        // kameraströmmen rakt av istället: vi förlorar zoom, bild-i-bild och
        // tidsstämpel, men filmen blir en riktig film.
        this.mode = 'direct';
        this.#emit('note', {
          text: 'Telefonen klarar inte bild-i-bild. Spelar in kamerabilden direkt istället.',
        });
      }
    }

    await this.#requestWakeLock();
    try {
      this.#startSegment();
    } catch (e) {
      // Skapades ingen inspelare läcker annars vaklåset och strömmarna vi just
      // tagit — kameran lyser vidare fast inget spelas in. Släpp och kasta.
      this.#releaseWakeLock();
      this.#stopStream(this.rearStream);  this.rearStream = null;
      this.#stopStream(this.frontStream); this.frontStream = null;
      this.#stopStream(this.audioStream); this.audioStream = null;
      throw e;
    }

    this.recording = true;
    this.#emit('start', { dual: this.dualActive });
    this.#emit('change');
  }

  async stop() {
    this.recording = false;
    clearTimeout(this.segmentTimer);
    this.#stopLoop();
    await this.#finishSegment();
    this.#stopStream(this.rearStream);  this.rearStream = null;
    this.#stopStream(this.frontStream); this.frontStream = null;
    this.#stopStream(this.audioStream); this.audioStream = null;
    this.#releaseWakeLock();
    this.#emit('stop');
    this.#emit('change');
  }

  #stopStream(s) { s?.getTracks().forEach(t => t.stop()); }

  /* ---- Zoom ---- */

  /** Optisk/hårdvaruzoom om telefonen erbjuder det — bättre än att beskära. */
  #applyNativeZoom() {
    const pairs = [[this.rearStream, this.settings.zoomRear], [this.frontStream, this.settings.zoomFront]];
    for (const [stream, want] of pairs) {
      const track = stream?.getVideoTracks?.()[0];
      if (!track?.getCapabilities) continue;
      const caps = track.getCapabilities();
      if (!caps.zoom) continue;
      const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min, want));
      track.applyConstraints({ advanced: [{ zoom: z }] }).catch(() => {});
      track._nativeZoom = z;
    }
  }

  setZoom(which, value) {
    const v = Math.min(5, Math.max(1, +value || 1));
    if (which === 'front') this.settings.zoomFront = v; else this.settings.zoomRear = v;
    this.#applyNativeZoom();
    this.#emit('change');
  }

  /** Hur mycket canvas måste beskära, utöver det hårdvaran redan zoomat. */
  #digitalZoom(stream, want) {
    const track = stream?.getVideoTracks?.()[0];
    const native = track?._nativeZoom || 1;
    return Math.max(1, want / native);
  }

  setOrientation(o) {
    if (o !== 'portrait' && o !== 'landscape') return;
    if (this.settings.orientation === o) return;
    this.settings.orientation = o;
    this.#resizeCanvas();
    // Byter man format mitt i inspelningen klipper vi segmentet så att varje
    // fil har ett enda bildformat — annars blir uppspelningen trasig.
    if (this.recording) this.#rollSegment();
    this.#emit('change');
  }

  /**
   * Ändra en inställning — och låt den faktiskt slå igenom.
   *
   * Tidigare skrev den bara in värdet i objektet. Det räckte för inställningar
   * man ändrar innan man startar, men inte för `fps` och `quality`: ritloopen
   * läser bildfrekvensen bara i start(), och canvasens storlek sätts bara av
   * #resizeCanvas(). En sänkning under pågående inspelning gjorde alltså
   * ingenting alls.
   *
   * Det spelar roll nu när värmevakten kan begära en sänkning för att
   * telefonen inte hinner med. En rekommendation som tyst ignoreras är värre
   * än ingen alls — då tror både appen och föraren att något gjordes.
   *
   * Kvalitetsbytet klipper segmentet först. Byter man canvasens mått mitt i
   * ett segment får filmen två upplösningar i samma fil, och en del spelare
   * vägrar då spela upp den alls.
   */
  setSetting(key, value) {
    const fore = this.settings[key];
    this.settings[key] = value;
    if (fore === value) { this.#emit('change'); return; }

    if (this.recording) {
      if (key === 'fps') {
        this.#loop();                 // startar om timern med den nya takten
      } else if (key === 'quality') {
        this.#resizeCanvas();
        this.#rollSegment();          // nytt segment med de nya måtten
      }
    }
    this.#emit('change');
  }

  /* ---- Rendering ---- */

  #resizeCanvas() {
    const { w, h } = this.resolution;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  /**
   * Rita bildrutor till canvasen som spelas in.
   *
   * Drivs av en timer, inte requestAnimationFrame. Skälet är hela poängen med
   * en dashcam: rAF stoppas HELT när skärmen släcks eller appen hamnar i
   * bakgrunden. Canvasen slutade då uppdateras, och eftersom det är canvasen
   * som spelas in blev resultatet en frusen bild — precis under den färd man
   * mest av allt vill ha filmad.
   *
   * En timer stryps i bakgrunden, ofta till en gång i sekunden. Det ger en
   * hackig film istället för en fryst, vilket är skillnaden mellan att kunna
   * visa vad som hände och att inte kunna det.
   *
   * Vill man ha full bildfrekvens med släckt skärm måste kameraströmmen
   * spelas in direkt istället för via canvas — se lägesbytet i start(). Då
   * försvinner dock överlägget med hastighet och tid.
   */
  #loop() {
    const intervalMs = Math.max(20, Math.round(1000 / (this.settings.fps || 30)));
    clearInterval(this.drawTimer);
    this.drawTimer = setInterval(() => this.#drawFrame(), intervalMs);
    this.#drawFrame();
  }

  #stopLoop() {
    clearInterval(this.drawTimer);
    this.drawTimer = null;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
  }

  #drawFrame() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    this.#drawVideoCover(this.rearVideo, 0, 0, W, H,
      this.#digitalZoom(this.rearStream, this.settings.zoomRear));

    if (this.dualActive && this.frontVideo.readyState >= 2) {
      const pipW = Math.round(W * (this.settings.orientation === 'portrait' ? 0.34 : 0.24));
      const pipH = Math.round(pipW * 3 / 4);
      const m = Math.round(W * 0.025);
      const pos = this.settings.pip;
      const x = pos.includes('right') ? W - pipW - m : m;
      const y = pos.includes('bottom') ? H - pipH - m : m;

      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.6)';
      ctx.shadowBlur = 18;
      this.#roundRect(ctx, x, y, pipW, pipH, 12);
      ctx.clip();
      ctx.fillStyle = '#111';
      ctx.fillRect(x, y, pipW, pipH);
      this.#drawVideoCover(this.frontVideo, x, y, pipW, pipH,
        this.#digitalZoom(this.frontStream, this.settings.zoomFront), true);
      ctx.restore();

      ctx.strokeStyle = 'rgba(255,255,255,.55)';
      ctx.lineWidth = Math.max(2, W / 500);
      this.#roundRect(ctx, x, y, pipW, pipH, 12);
      ctx.stroke();
    }

    if (this.settings.stamp) this.#drawStamp(ctx, W, H);
  }

  /** Rita videon så den täcker rutan, med beskärning för zoom. */
  #drawVideoCover(video, dx, dy, dw, dh, zoom = 1, mirror = false) {
    if (!video || video.readyState < 2) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;

    // Källrektangel: först "cover"-beskärning, sedan zoom mot mitten
    const scale = Math.max(dw / vw, dh / vh);
    let sw = dw / scale, sh = dh / scale;
    sw /= zoom; sh /= zoom;
    const sx = (vw - sw) / 2, sy = (vh - sh) / 2;

    if (mirror) {
      this.ctx.save();
      this.ctx.translate(dx + dw, dy);
      this.ctx.scale(-1, 1);
      this.ctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
      this.ctx.restore();
    } else {
      this.ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
    }
  }

  #roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * Tid, datum och hastighet inbränt i bilden.
   *
   * Hastigheten kommer från GPS:en, inte från kameran. Telefonen räknar ut
   * den ur satellitsignalens dopplerskift, och där den saknas räknar appen
   * själv fram farten ur hur långt positionen flyttat sig mellan två fixar.
   * Kameran mäter ingenting — den filmar bara.
   *
   * Avstånd mäter vi inte alls. Det skulle kräva två kameror eller en känd
   * referens i bilden, och en enskild lins kan inte skilja en liten bil nära
   * från en stor bil långt bort.
   */
  #drawStamp(ctx, W, H) {
    const now = new Date();
    const pad = str => String(str).padStart(2, '0');
    const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
                 `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const speed = this.overlay.speedKmh != null ? `  ${this.overlay.speedKmh} km/h` : '';
    const text = time + speed;

    const size = Math.round(W * 0.032);
    ctx.font = `600 ${size}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'bottom';
    const m = Math.round(W * 0.025);
    const tw = ctx.measureText(text).width;

    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fillRect(m - 8, H - m - size - 8, tw + 16, size + 14);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, m, H - m);
  }

  /* ---- Segmentinspelning ---- */

  /**
   * Vad som faktiskt spelas in.
   *
   * Normalt canvasen, som ger zoom, tidsstämpel och bild-i-bild. Visade sig
   * canvasen vara svart på den här telefonen spelar vi in kameraströmmen rakt
   * av istället — sämre funktioner, men en film som går att använda om något
   * händer. Det är alltid rätt kompromiss för en dashcam.
   */
  #buildStream() {
    const out = this.mode === 'direct'
      ? new MediaStream(this.rearStream.getVideoTracks())
      : this.canvas.captureStream(30);
    if (this.audioStream) {
      for (const t of this.audioStream.getAudioTracks()) out.addTrack(t);
    }
    return out;
  }

  /** Byt till nästa fysiska kamera. Telefoner har ofta vidvinkel och tele. */
  /**
   * Är det här selfiekameran?
   *
   * Bara positiva svar räknas. Vet vi inte säkert svarar vi nej, eftersom en
   * vanlig dator har en enda webbkamera utan facingMode — och att blockera
   * den hade gjort dashcamen omöjlig att testa på annat än telefon.
   */
  #isFrontFacing(track) {
    if (!track) return false;
    try {
      const s = track.getSettings?.() || {};
      if (s.facingMode === 'user') return true;
      if (s.facingMode === 'environment') return false;
    } catch {}
    const namn = (track.label || '').toLowerCase();
    if (!namn) return false;
    if (/\b(back|rear|environment|bak)\b/.test(namn)) return false;
    return /\b(front|user|selfie|face|fram)\b/.test(namn);
  }

  /**
   * Kameror som duger som huvudbild.
   *
   * Selfiekameran märks ut men tas inte bort ur listan — den behövs för
   * kupébilden. Den får däremot aldrig väljas som den som filmar framåt.
   */
  async listCameras() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter(d => d.kind === 'videoinput').map(d => {
        const namn = (d.label || '').toLowerCase();
        const front = /\b(front|user|selfie|face|fram)\b/.test(namn) &&
                      !/\b(back|rear|environment|bak)\b/.test(namn);
        return Object.assign(Object.create(Object.getPrototypeOf(d)), {
          deviceId: d.deviceId, groupId: d.groupId, kind: d.kind, label: d.label,
          front,
          duggerSomHuvudbild: !front,
        });
      });
    } catch { return []; }
  }

  /**
   * Byt kamera under pågående inspelning utan att tappa filmen. Segmentet
   * klipps, den nya kameran kopplas in, och inspelningen fortsätter.
   */
  async useCamera(deviceId) {
    const wasRecording = this.recording;
    const res = this.resolution;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: Math.max(res.w, res.h) },
          height: { ideal: Math.min(res.w, res.h) },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });
    } catch (e) {
      this.#emit('note', { text: 'Kunde inte byta kamera.' });
      return false;
    }

    // Huvudbilden filmar framåt. Selfiekameran hör hemma på kupéspåret och
    // ingen annanstans — annars går det att råka spela in sig själv i en
    // timme och tro att man har vägen framför sig på film.
    if (this.#isFrontFacing(stream.getVideoTracks()[0])) {
      this.#stopStream(stream);
      this.#emit('note', {
        text: 'Den kameran vänder mot dig. Huvudbilden måste filma framåt — ' +
              'slå på kupékameran i inställningarna om du vill filma inne i bilen.',
      });
      return false;
    }

    this.#stopStream(this.rearStream);
    this.rearStream = stream;
    this.rearVideo.srcObject = stream;
    await this.rearVideo.play().catch(() => {});
    const ok = await this.#waitForFrame(this.rearVideo);
    this.#applyNativeZoom();

    if (wasRecording) this.#rollSegment();
    this.#emit('note', {
      text: ok ? `Bytte kamera: ${this.rearVideo.videoWidth}×${this.rearVideo.videoHeight}`
               : 'Den kameran gav ingen bild.',
    });
    this.#emit('change');
    return ok;
  }

  #startSegment() {
    const mime = pickMime();
    const stream = this.#buildStream();
    let rec;
    try {
      rec = new MediaRecorder(stream, {
        mimeType: mime || undefined,
        videoBitsPerSecond: this.bitrate,
        audioBitsPerSecond: 128000,
      });
    } catch {
      rec = new MediaRecorder(stream);
    }
    this.segmentChunks = [];
    this.segmentStart = Date.now();
    this._mime = rec.mimeType || mime || 'video/webm';

    rec.ondataavailable = e => { if (e.data && e.data.size) this.segmentChunks.push(e.data); };
    rec.onstop = () => this.#saveSegment();
    rec.start(1000);
    this.recorder = rec;

    this.segmentTimer = setTimeout(() => this.#rollSegment(), this.settings.segmentSeconds * 1000);
  }

  #rollSegment() {
    if (!this.recording) return;
    clearTimeout(this.segmentTimer);
    const rec = this.recorder;
    this.recorder = null;
    if (rec && rec.state !== 'inactive') {
      rec.onstop = () => {
        this.#saveSegment();
        if (!this.recording) return;
        try {
          this.#startSegment();
        } catch (e) {
          // Ett kastat fel här sväljs av webbläsarens eventutskick och hade
          // lämnat recording=true utan inspelare och utan timer — dashcamen
          // "spelar in" i UI:t men gör ingenting. Stäng ner rent i stället.
          this.#nodstopp('Inspelningen stannade — kunde inte fortsätta filma.');
        }
      };
      rec.stop();
    } else if (this.recording) {
      try { this.#startSegment(); }
      catch { this.#nodstopp('Inspelningen stannade — kunde inte fortsätta filma.'); }
    }
  }

  /** Nödstopp när ett nytt segment inte gick att starta mitt i en inspelning. */
  #nodstopp(text) {
    this.recording = false;
    clearTimeout(this.segmentTimer);
    this.#stopStream(this.rearStream);  this.rearStream = null;
    this.#stopStream(this.frontStream); this.frontStream = null;
    this.#stopStream(this.audioStream); this.audioStream = null;
    this.#releaseWakeLock();
    this.#emit('note', { text });
    this.#emit('stop');
    this.#emit('change');
  }

  async #finishSegment() {
    const rec = this.recorder;
    this.recorder = null;
    if (!rec || rec.state === 'inactive') return;
    await new Promise(resolve => {
      rec.onstop = async () => { await this.#saveSegment(); resolve(); };
      rec.stop();
    });
  }

  async #saveSegment() {
    const chunks = this.segmentChunks;
    this.segmentChunks = [];
    if (!chunks.length) return;
    const blob = new Blob(chunks, { type: this._mime });
    if (blob.size < 20000) return;   // för kort för att vara användbar

    const clip = {
      startedAt: this.segmentStart,
      endedAt: Date.now(),
      durationMs: Date.now() - this.segmentStart,
      size: blob.size,
      mime: this._mime,
      orientation: this.settings.orientation,
      dual: this.dualActive,
      locked: this._lockNext ? 1 : 0,
      blob,
    };
    if (this._lockNext) this._lockNext = false;

    try {
      await idbPut(clip);
      await this.#pruneBuffer();
      this.#emit('clips');
    } catch (e) {
      this.lastError = e.message;
      this.#emit('note', { text: 'Lagringen är full. Radera gamla klipp.' });
    }
  }

  /**
   * En halvtimme i 1080p är drygt en gigabyte. Telefoner ger webbappar
   * betydligt mindre än så ibland, och en dashcam som slår i taket mitt under
   * körning är värdelös. Korta ner bufferten tyst istället, och säg till.
   */
  async #fitBufferToQuota() {
    let quota = null;
    try { quota = (await navigator.storage?.estimate?.())?.quota ?? null; } catch {}
    if (!quota) return;

    const bytesPerMinute = (this.bitrate / 8) * 60;
    const budget = quota * 0.6;                       // lämna plats åt allt annat
    const maxMinutes = Math.floor(budget / bytesPerMinute);

    if (maxMinutes < 3) {
      // Inte ens tre minuter ryms — sänk kvaliteten istället för att ge upp
      const order = ['high', 'medium', 'low'];
      const i = order.indexOf(this.settings.quality);
      if (i < order.length - 1) {
        this.settings.quality = order[i + 1];
        this.#resizeCanvas();
        this.#emit('note', { text: `Lite lagringsutrymme kvar. Sänker till ${this.settings.quality === 'medium' ? '720p' : '480p'}.` });
        return this.#fitBufferToQuota();
      }
    }

    if (maxMinutes < this.settings.bufferMinutes) {
      const was = this.settings.bufferMinutes;
      this.settings.bufferMinutes = Math.max(3, maxMinutes);
      this.#emit('note', {
        text: `Lagringsutrymmet räcker till ${this.settings.bufferMinutes} min istället för ${was}. Radera gamla klipp för längre buffert.`,
      });
      this.#emit('change');
    }
  }

  /** Loopa bort de äldsta olåsta klippen när bufferten är full. */
  async #pruneBuffer() {
    const clips = await idbGetAll();
    const budgetMs = this.settings.bufferMinutes * 60000;
    const unlocked = clips.filter(c => !c.locked).sort((a, b) => a.startedAt - b.startedAt);
    let total = unlocked.reduce((s, c) => s + c.durationMs, 0);
    while (total > budgetMs && unlocked.length > 1) {
      const oldest = unlocked.shift();
      total -= oldest.durationMs;
      await idbDelete(oldest.id);
    }
  }

  /* ---- Händelser ---- */

  /**
   * Lås klippen runt just nu så de överlever loopen. Används vid krock
   * eller tillbud — trycker man knappen sparas det som redan hänt plus
   * nästa segment.
   */
  async saveEvent(windowMinutes = 3) {
    const cutoff = Date.now() - windowMinutes * 60000;
    const clips = await idbGetAll();
    let n = 0;
    for (const c of clips) {
      if (c.endedAt >= cutoff && !c.locked) {
        c.locked = 1;
        await idbPut(c);
        n++;
      }
    }
    this._lockNext = true;         // även det pågående segmentet
    if (this.recording) this.#rollSegment();  // skriv ut det som spelats hittills
    this.#emit('clips');
    this.#emit('note', { text: `Händelse sparad. ${n + 1} klipp skyddade mot radering.` });
    return n + 1;
  }

  /* ---- Klippbibliotek ---- */

  async listClips() {
    const clips = await idbGetAll();
    return clips.sort((a, b) => b.startedAt - a.startedAt);
  }

  async toggleLock(id) {
    const clips = await idbGetAll();
    const c = clips.find(x => x.id === id);
    if (!c) return;
    c.locked = c.locked ? 0 : 1;
    await idbPut(c);
    this.#emit('clips');
  }

  async deleteClip(id) {
    await idbDelete(id);
    this.#emit('clips');
  }

  async deleteAll({ includeLocked = false } = {}) {
    const clips = await idbGetAll();
    for (const c of clips) {
      if (!includeLocked && c.locked) continue;
      await idbDelete(c.id);
    }
    this.#emit('clips');
  }

  async storageUsed() {
    const clips = await idbGetAll();
    const bytes = clips.reduce((s, c) => s + (c.size || 0), 0);
    let quota = null;
    try {
      const est = await navigator.storage?.estimate?.();
      quota = est?.quota ?? null;
    } catch {}
    return { bytes, count: clips.length, quota };
  }

  /* ---- Skärmlås ---- */

  async #requestWakeLock() {
    try {
      this.wakeLock = await navigator.wakeLock?.request('screen');
      document.addEventListener('visibilitychange', this._wl = async () => {
        if (document.visibilityState === 'visible' && this.recording && !this.wakeLock) {
          try { this.wakeLock = await navigator.wakeLock.request('screen'); } catch {}
        }
      });
    } catch { this.wakeLock = null; }
  }

  #releaseWakeLock() {
    try { this.wakeLock?.release(); } catch {}
    this.wakeLock = null;
    if (this._wl) document.removeEventListener('visibilitychange', this._wl);
  }

  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
}

export const fmtBytes = b => {
  if (b == null) return '–';
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} kB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1048576).toFixed(0)} MB`;
  return `${(b / 1073741824).toFixed(1).replace('.', ',')} GB`;
};

export const fmtDuration = ms => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
