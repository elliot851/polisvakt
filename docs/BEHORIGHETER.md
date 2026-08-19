# Behörigheter — de tre sakerna som avgör om appen gör någon nytta

Polisvakt utan tillstånd är inte en app som fungerar sämre. Det är en karta som
inte vet var du är och en röst som aldrig hörs. Tre saker måste vara på:

| Behörighet | Kan appen se den själv? | Utan den |
|------------|-------------------------|----------|
| **Plats** | Ja, oftast (inte i Safari) | Inga varningar alls, och ingen påminnelse kan läras in |
| **Notiser** | Ja | Inget når dig när appen är stängd |
| **Fokus / Stör ej** | **Nej. Aldrig.** | Notiserna finns men hörs inte |

Koden ligger i [`js/behorigheter.js`](../js/behorigheter.js). Guiden som frågar
efter dem är stegen 2–4 i [`js/tour.js`](../js/tour.js). Push-kedjan som
notiserna färdas i beskrivs i [NOTISER.md](NOTISER.md).

---

## Först: vad appen gör när den är stängd

Det här står först för att det är den enda raden i dokumentet som kan bli ett
säkerhetsproblem om någon tror fel.

> **Polisvakt varnar inte i bakgrunden.** Appen måste vara öppen och framme för
> att läsa GPS och säga till.

**Vad appen kan göra när den är stängd:**

- Skicka en notis som påminner dig att slå på appen innan du kör, baserad på
  tider du brukar köra.
- Skicka en notis när polis rapporterats i närheten, genom samma kanal.

**Vad den inte kan göra, oavsett vilka tillstånd du gett:**

- Läsa din position. Webbläsaren stänger av GPS så fort appen inte ligger
  framme. Det går inte att koda sig runt — inte med service worker, inte med
  wake lock, inte med något annat.
- Säga något med rösten.
- Räkna hastighet, hålla koll på fartkameror eller lära sig dina vanor.

Det betyder att en förare som lämnar telefonen i fickan **inte** är bevakad.
Hela poängen med påminnelsen är just den saken: appen kan inte hålla vakt åt
dig, så den knuffar dig att slå på den själv.

Texterna finns som `BAKGRUND` i `js/behorigheter.js` så att UI och dokumentation
säger exakt samma sak. Mjuka inte upp dem.

---

## 1. Plats

**Låser upp:** kartan, avstånden i listan, hastigheten, fartkameravarningarna,
"rapportera här" — och körningsdetekteringen i `js/driving.js`.

**Går sönder utan den:** allt. Det finns inget läge där appen är delvis
användbar utan plats. Kartan hittar dig inte, ingen varning kan avgöra om den
är relevant, och `driving.js` kan aldrig registrera en körning. Utan
registrerade körningar finns inga vanor, och utan vanor kan servern aldrig
skicka påminnelsen "du glömde slå på Polisvakt". Kedjan börjar här.

### Safari svarar inte på frågan

Permissions API finns i WebKit men `'geolocation'` är inte ett giltigt namn
där — anropet kastar `TypeError` istället för att svara. Chrome, Edge, Firefox
och Samsung Internet svarar.

Därför har `platsStatus()` läget **`okand`**, och `verifierad: false`. Det är
ett riktigt svar, inte ett fel: "den här webbläsaren berättar inte, och vi har
inte frågat telefonen än". Det enda sättet att få veta är att faktiskt be om
positionen och se vad som händer. Gissa aldrig åt andra hållet — en iPhone som
märks som nekad när den bara är otillfrågad skickar användaren till fel meny.

`koppla(tracker)` löser samma sak från andra hållet: varje position som
`GeoTracker` läser bevisar att tillståndet finns, varje fel med `code === 1`
bevisar motsatsen. Det är den färskaste källan som finns.

### Slå på igen efter ett nej

Webbläsaren frågar aldrig igen när man en gång sagt nej. Det måste göras i
inställningarna.

**iPhone, appen på hemskärmen**

1. Inställningar → Appar → Polisvakt. (På iOS 17 och äldre ligger appen längst
   ner i huvudlistan i Inställningar.)
2. Plats → **Vid användning av appen**.
3. Kontrollera Inställningar → Integritet och säkerhet → Platstjänster.

Välj inte "Alltid". Det finns inget läge där en webbapp läser position i
bakgrunden, så det ger ingenting utom en onödig behörighet.

**iPhone, i en Safari-flik**

1. Inställningar → Appar → Safari. (iOS 17 och äldre: Inställningar → Safari.)
2. Under **Inställningar för webbplatser** → Plats → **Fråga**.
3. Inställningar → Integritet och säkerhet → Platstjänster → **Safari-webbplatser**
   → Vid användning av appen.
4. Ladda om sidan.

**Android, appen installerad från startskärmen**

1. Inställningar → Appar → Polisvakt → Behörigheter → Plats.
2. **Tillåt endast medan appen används**, med exakt position påslagen.
3. Inställningar → Plats måste vara på för hela telefonen.

**Android, i webbläsaren**

1. Tryck på ikonen till vänster om adressfältet → Behörigheter → Plats.
2. Saknas raden: ⋮ → Inställningar → Webbplatsinställningar → Plats → leta upp
   polisvakt-adressen → Tillåt.
3. Webbläsaren själv måste också ha plats: Inställningar → Appar → Chrome →
   Behörigheter → Plats.

**Dator**

Ikonen till vänster om adressfältet → Plats → Tillåt, ladda om. På en dator
kommer positionen från nätverket och kan vara hundratals meter fel; appen är
byggd för telefon i bil.

---

## 2. Notiser

**Låser upp:** påminnelsen att slå på appen innan du kör, och pling när polis
rapporterats i närheten medan appen är stängd.

**Går sönder utan den:** ingenting medan du kör med appen öppen — men den
vanligaste anledningen till att en varningsapp inte hjälper någon är inte att
varningarna är dåliga, det är att appen aldrig startades. Utan notiser finns
ingen kanal alls som kan påminna dig, eftersom en webbapp varken får köra
timers eller läsa GPS i bakgrunden.

`notisStatus()` äger ingen egen plattformskunskap. Allt kommer från
`capabilities()` i `js/push.js`: iPhone-kravet på hemskärm, iOS-versionen,
avsaknad av VAPID-nyckel. Den kunskapen ska finnas på ett ställe.

### iPhone måste ligga på hemskärmen

Safari på iOS skickar bara push till webbappar som lagts till på hemskärmen,
och bara från iOS 16.4. I en vanlig Safari-flik finns `window.PushManager`
inte alls. Se [NOTISER.md avsnitt 1](NOTISER.md) — det är Apples begränsning,
inte vår, och den går inte att koda sig runt.

1. Dela-knappen i Safari → **Lägg till på hemskärmen**.
2. Starta appen från ikonen.
3. Kör guiden igen därifrån.

### Slå på igen efter ett nej

**iPhone:** Inställningar → Notiser → Polisvakt → Tillåt notiser. Slå även på
**Tidskänsliga notiser** — utan den hålls varningen tillbaka i fokuslägen.

**Android, installerad app:** Inställningar → Aviseringar → Appaviseringar →
Polisvakt.

**Android, i webbläsaren:** ⋮ → Inställningar → Webbplatsinställningar →
Aviseringar → leta upp polisvakt-adressen under Blockerat → Tillåt. Webbläsaren
själv måste också få skicka aviseringar.

### Notiser utan server

Är `VAPID_PUBLIC_KEY` tom rapporterar `push.js` `fix: 'server'`. Då kan
tillstånd fortfarande begäras — det räcker för påminnelser som `driving.js`
visar medan appen är öppen — men inget kommer fram när appen är stängd.
`begarNotiser()` säger det rakt ut istället för att låtsas att det gick.

---

## 3. Fokus och Stör ej

Den här punkten är anledningen till att dokumentet finns. Alla de andra går att
läsa av; den här går inte.

**Låser upp:** att notiserna faktiskt hörs.

**Går sönder utan den:** användaren har sagt ja till allt, ser gröna prickar i
appen, och hör ändå ingenting. Slutsatsen blir "appen är trasig" och appen
avinstalleras. Behörigheten var aldrig problemet.

### Det går inte att detektera

Det finns inget webb-API som avslöjar om telefonen är i ett fokusläge, varken
på iOS eller Android, och det kommer det inte att göra — det vore ett läckage
av personlig status. Därför:

- `fokusStatus()` har alltid `detekterbar: false` och `verifierad: false`.
- Läget är `okontrollerad` tills användaren själv trycker "Jag har kollat".
- Vi bygger inget hemmasnickrat test heller. "Vi visade en notis och den kom
  inte fram, alltså Stör ej" går inte att skilja från tio andra orsaker, och en
  felaktig gissning skickar användaren till fel meny.

### iPhone: fokuset Kör bil är den farliga

**Kör bil slår på sig själv.** iPhone startar det när den känner av biltempo
eller kopplar till bilens Bluetooth — alltså exakt i det ögonblick Polisvakt
ska höras. Är appen inte tillagd som tillåten där hörs ingenting, hur många ja
användaren tryckt på tidigare.

1. Inställningar → **Fokus**.
2. Öppna varje fokus som används — särskilt **Kör bil** och **Stör ej**.
3. Under **Tillåtna notiser** → **Appar** → lägg till Polisvakt.
4. Inställningar → Notiser → Polisvakt → slå på **Tidskänsliga notiser**.
5. Kontrollera när fokuset startar av sig själv: Inställningar → Fokus →
   Kör bil → **Aktivera automatiskt**.

### Android: Stör ej och lägen

1. Inställningar → **Lägen** → **Stör ej**. (Äldre Android: Inställningar →
   Aviseringar → Stör ej.)
2. Under **Aviseringsfilter** → **Appar** → lägg till Polisvakt.
3. Samsung: Inställningar → Aviseringar → Stör ej → **Tillåtna undantag** →
   Appaviseringar.
4. Kolla scheman och rutiner som slår på Stör ej automatiskt — bilhållare,
   Bluetooth, Android Auto.

Ligger appen inte på startskärmen som egen ikon heter den webbläsarens namn i
listan, inte Polisvakt. Det är den vanligaste anledningen till att någon inte
hittar raden.

Menyvägarna är kontrollerade mot Apples och Googles egna supportsidor i augusti
2026. Ändrar Apple eller Google en meny är det `instruktioner()` i
`js/behorigheter.js` som ska uppdateras — texterna finns bara där, och det här
dokumentet beskriver samma sak i löpande text.

---

## Så används modulen

```js
import * as behorigheter from './behorigheter.js';

// Allt på en gång, i visningsordning
const st = await behorigheter.status();
st.klart          // true bara när alla tre är ok
st.saknas         // t.ex. ['notiser', 'fokus']
st.lista          // [plats, notiser, fokus] — samma form på alla tre

// Snabb variant som inte väntar på service workern
const snabb = await behorigheter.snabbStatus();

// Fråga på riktigt. MÅSTE ligga direkt i ett fingertryck.
knapp.onclick = async () => {
  await behorigheter.begarPlats();
  await behorigheter.begarNotiser({ deviceId: deviceId(), habits: detector.habits });
};

// Fokus har ingen systemruta — användaren bekräftar själv
behorigheter.bekraftaFokus(true);

// Låt GPS-spårningen mata in sanningen medan appen används
const loss = behorigheter.koppla(tracker);

// Rita om när något ändras
behorigheter.events.addEventListener('andrad', e => rita(e.detail.vad));
```

Varje post i `lista` har samma fält: `nyckel`, `namn`, `state`, `ok`,
`verifierad`, `kanFraga`, `text`, `reason`. Modulen rör aldrig DOM:en.

### Gesten är ömtålig

Både `Notification.requestPermission()` och `getCurrentPosition()` kräver att
anropet ligger i samma uppgift som klicket. Ett `await` före raden — hämta
något, läsa en fil — och gesten hinner gå ut, rutan visas aldrig, och det ser
ut som att knappen är trasig. `begarPlats()` är därför ett `Promise` utan
`async`, och `begarNotiser()` gör ingenting före anropet till `push.enable()`.
Flytta inte de raderna.

---

## Att vara ärlig om

**Ett grönt ljus är en ögonblicksbild.** Användaren kan dra tillbaka
tillståndet i systeminställningarna medan appen ligger framme. Permissions API
meddelar oss när det gäller plats (vi lyssnar på `onchange`), men notiser har
ingen motsvarighet — det läget måste läsas om varje gång rutan visas.

**Fokusbekräftelsen bevisar ingenting.** Den betyder bara att användaren varit
inne och tittat, eller tryckt bort en knapp. Det är den enda sanning som finns
att få, och den är märkt `verifierad: false` överallt just därför.

**Ett nej går inte att fråga om igen.** Varken plats eller notiser kan begäras
en andra gång efter ett nej, i någon webbläsare. Enda vägen tillbaka är
inställningarna, och därför visar guiden menyvägen direkt istället för en knapp
som inte skulle göra något.

**Vi frågar tidigt i guiden, inte vid första kartöppningen.** Steg 2–4 av 15.
Skälet är att resten av guiden beskriver funktioner som inte finns utan
tillstånd. Priset är att frågan kommer innan användaren sett värdet — därför
förklarar varje steg vad behörigheten låser upp innan knappen trycks.

**Notiser om polis i närheten kräver att servern skickar dem.** Idag skickar
`supabase/functions/send-reminder` påminnelser om att slå på appen. Larm om
närliggande rapporter går genom samma push-kanal och samma tillstånd — men den
funktionen finns ännu inte på serversidan. Notistillståndet är förutsättningen,
inte hela funktionen.
