# Notiser i Polisvakt — påminnelser som kommer fram när appen är stängd

Den här guiden tar dig från "appen kan visa en notis medan den är öppen" till
"telefonen plingar 07:15 på en tisdag, med appen helt stängd". Räkna med
**30–45 minuter**.

Läs **avsnitt 1 om iPhone** innan du bygger något UI kring det här. Där finns
en begränsning som inte går att koda sig runt, och som avgör hur knappen ska
se ut.

---

## Så hänger det ihop

```
Telefonen                Pushtjänsten                Supabase
─────────                ────────────                ────────
Användaren trycker
"Slå på påminnelser"
  └─ Notification.requestPermission()
  └─ pushManager.subscribe(VAPID-publik nyckel)
     ← endpoint + p256dh + auth
  └─ save_push_subscription  ──────────────────────▶ push_subscriptions
                                                       (endpoint, nycklar,
                                                        tidszon, vanor)

                          ... appen stängs ...

                                            var 5:e minut ─▶ send-reminder
                                                              │ due_push_reminders
                                                              │ krypterar aes128gcm
                                                              │ signerar VAPID-JWT
                          POST endpoint  ◀────────────────────┘
  OS väcker sw.js
  └─ push-händelsen
  └─ showNotification()
```

Det som är värt att förstå: **`auth`-nyckeln i `push_subscriptions` är en
delad hemlighet.** Den som har `endpoint` + `auth` kan skicka vilken notis som
helst till den telefonen, i Polisvakts namn. Därför har tabellen **ingen
läsregel alls** — inte ens för inloggade. Se kommentaren överst i
`supabase/push.sql` innan du frestas att lägga till en.

---

## 1. iPhone: appen måste ligga på hemskärmen

Det här är den viktigaste raden i hela dokumentet.

**Safari på iOS skickar bara push till webbappar som lagts till på
hemskärmen, och bara från iOS 16.4 och uppåt.** I en vanlig Safari-flik finns
`window.PushManager` inte alls, oavsett hur ny telefonen är. Det gäller
fortfarande 2026 och Apple har inte visat några tecken på att ändra det.

Praktiskt betyder det:

- En iPhone-användare som surfar in på polisvakt-sidan kan **aldrig** få
  påminnelser. Knappen "Tillåt notiser" kan inte ens visa systemrutan.
- Först när hen tryckt **Dela → Lägg till på hemskärmen** och startat appen
  **från ikonen** dyker API:et upp.
- Notistillståndet måste dessutom begäras i samma tryck som knappen. Ligger
  det ett `await` före `Notification.requestPermission()` hinner gesten gå ut
  och rutan visas aldrig. `js/push.js` är byggd så — flytta inte den raden.

`capabilities()` i `js/push.js` skiljer på de här fallen och returnerar en
färdig förklaring på svenska:

| `fix`        | Betyder                          | Visa                             |
|--------------|----------------------------------|----------------------------------|
| `null`       | Allt fungerar                    | Knappen "Slå på påminnelser"     |
| `hemskarm`   | iPhone, inte på hemskärmen       | Länk till installationsguiden    |
| `uppdatera`  | iOS äldre än 16.4                | Be användaren uppdatera iOS      |
| `webblasare` | Webbläsaren kan inte             | Dölj knappen                     |
| `server`     | VAPID-nyckel saknas i appen      | Dölj knappen (vårt fel, inte deras) |

**Gör inte** en knapp som bara försvinner på iPhone. Då tror användaren att
funktionen inte finns, när den i själva verket ligger två tryck bort. Visa
`reason`-texten och länka till "Lägg till på hemskärmen"-guiden som redan
finns i `js/install.js`.

Android och Chrome/Edge/Firefox på datorn har inga sådana krav.

---

## 2. Generera VAPID-nycklar

VAPID är hur pushtjänsten vet att pushen kommer från oss och inte från någon
som snappat upp en endpoint. Ett nyckelpar, en gång, för hela appen.

```sh
deno run https://raw.githubusercontent.com/negrel/webpush/master/cmd/generate-vapid-keys.ts
```

Kommandot skriver **två saker på olika strömmar**, och det är lätt att missa:

- På **stdout**: ett JSON-objekt med `publicKey` och `privateKey` i JWK-form.
  Det här är hela hemligheten. Spara den.
- På **stderr**: raden `your application server key is: BN4...`. Det är samma
  publika nyckel i base64url, och det är den formen webbläsaren vill ha.

Spara båda:

```sh
deno run https://raw.githubusercontent.com/negrel/webpush/master/cmd/generate-vapid-keys.ts \
  > vapid.json 2> vapid-public.txt
```

> **Lägg aldrig `vapid.json` i git.** Med den kan vem som helst skicka notiser
> i Polisvakts namn till alla som prenumererar. Byter du nycklar slutar
> **samtliga** befintliga prenumerationer fungera och varje användare måste
> trycka på knappen igen — så gör det bara om nyckeln faktiskt läckt.

### Lägg in den publika nyckeln i appen

Öppna `js/push.js` och klistra in base64url-strängen från `vapid-public.txt`:

```js
export const VAPID_PUBLIC_KEY = 'BN4...';
```

Är den tom svarar `capabilities()` med `fix: 'server'` och knappen visas inte
alls, vilket är rätt beteende — bättre än en knapp som ger ett kryptiskt fel.

---

## 3. Kör SQL:en

Öppna **Supabase → SQL Editor** och kör hela `supabase/push.sql`.

Den förutsätter att `supabase/schema.sql` redan är körd, eftersom den använder
funktionen `public.actor()` därifrån. Filen går att köra om hur många gånger
som helst.

Kontrollera efteråt att rättigheterna blev rätt — det här är den enda
kontrollen som verkligen betyder något:

```sql
-- Ska ge NOLL rader. Får du träffar kan vem som helst med anon-nyckeln
-- hämta ut samtliga användares push-hemligheter.
select p.proname, r.rolname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral (values ('anon'),('authenticated')) as r(rolname)
where n.nspname = 'public'
  and p.proname in ('due_push_reminders','mark_push_sent',
                    'drop_push_subscription','note_push_failure')
  and has_function_privilege(r.rolname, p.oid, 'EXECUTE');
```

```sql
-- Ska ge noll policies. Tom radsäkerhet = bara service_role kommer in.
select policyname from pg_policies
where tablename = 'push_subscriptions';
```

---

## 4. Service workern måste fånga pushen

**Det här steget glöms bort oftast, och felet ser ut som att servern är
trasig.** Utan en `push`-lyssnare i `sw.js` tar telefonen emot meddelandet,
dekrypterar det och kastar det. Edge-funktionen får `201 Created` och allt
ser grönt ut i loggen. Ingen notis syns.

Lägg till i `sw.js`:

```js
/* ---- Push från servern ---- */
// Utan de här två lyssnarna kastas varje push tyst. Se docs/NOTISER.md.

self.addEventListener('push', e => {
  // Nyttolasten kommer från supabase/functions/send-reminder.
  let d = { title: 'Polisvakt', body: 'Dags att köra?', tag: 'polisvakt-reminder', url: './' };
  try { d = { ...d, ...(e.data?.json() ?? {}) }; } catch {}

  // waitUntil, alltid. Utan den får service workern dödas innan notisen
  // hunnit ritas, och på en telefon med lite minne händer det ofta.
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: './icon.svg',
    badge: './icon.svg',
    tag: d.tag,
    data: { url: d.url },
    // Ingen requireInteraction: en påminnelse ska gå att svepa bort, inte
    // ligga kvar i luren tills man rör vid den.
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || './';
  // Finns appen redan öppen ska den fokuseras, inte öppnas en gång till.
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => {
        for (const c of list) if ('focus' in c) return c.focus();
        return self.clients.openWindow(url);
      })
  );
});
```

Lägg också till `'./js/push.js'` i `SHELL`-listan i `sw.js` och bumpa
`VERSION`, annars hämtas den nya filen inte in i cachen.

---

## 5. Sätt hemligheterna och deploya

```sh
supabase secrets set VAPID_KEYS="$(cat vapid.json)"
supabase secrets set VAPID_SUBJECT="mailto:din@adress.se"
supabase secrets set CRON_SECRET="$(openssl rand -hex 24)"
```

I PowerShell på Windows:

```powershell
supabase secrets set VAPID_KEYS="$(Get-Content vapid.json -Raw)"
supabase secrets set VAPID_SUBJECT="mailto:din@adress.se"
supabase secrets set CRON_SECRET=(-join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) }))
```

Om de tre:

- **`VAPID_KEYS`** — hela JSON-objektet, inte bara den publika strängen. Det
  vanligaste felet här ger `Trasiga VAPID-nycklar` och 500 direkt vid första
  anropet.
- **`VAPID_SUBJECT`** — måste vara `mailto:` eller en `https:`-URL. Google och
  Mozilla använder den för att höra av sig om vi börjar bete oss illa, och
  Chrome svarar `400 Bad Request` på en tom eller felformaterad `sub`.
- **`CRON_SECRET`** — se avsnitt 6 om varför den inte är valfri.

`SUPABASE_URL` och `SUPABASE_SERVICE_ROLE_KEY` sätts av plattformen. Sätt dem
inte för hand.

```sh
supabase functions deploy send-reminder
supabase secrets list        # kontrollera att alla tre finns
```

Notera: **ingen** `--no-verify-jwt` här, till skillnad från `stripe-webhook`.
Schemaläggaren kan skicka en giltig nyckel, så det finns ingen anledning att
öppna funktionen.

---

## 6. Schemalägg körningen

Funktionen ska köras **var femte minut**. Två vägar — välj den första om du
inte har en anledning att välja den andra.

### A. Supabase Dashboard (rekommenderas)

**Edge Functions → send-reminder → Schedules → New schedule**

- Cron: `*/5 * * * *`
- HTTP-huvuden: lägg till `x-cron-secret` med värdet från `CRON_SECRET`
- Kropp: `{}`

### B. pg_cron + pg_net

Om du hellre vill ha allt i databasen. Färdig SQL finns längst ner i
`supabase/push.sql`.

Det viktiga där: **skriv aldrig nycklarna direkt i `cron.schedule`.** Tabellen
`cron.job` är läsbar för alla med databasåtkomst och följer med i varje
backup. Lägg dem som databasinställningar istället:

```sql
alter database postgres set app.service_role_key = 'eyJ...';
alter database postgres set app.cron_secret      = '<samma som CRON_SECRET>';
```

### Varför CRON_SECRET behövs

Supabase kräver som standard en giltig JWT för att en edge-funktion ska köras.
Det låter som skydd nog, men **anon-nyckeln räknas som giltig, och den ligger
öppet i `js/config.js`.** Vem som helst som läst appens källkod kan alltså
anropa funktionen — om och om igen — och trigga massutskick till samtliga
användare. `CRON_SECRET` är det som faktiskt skiljer schemaläggaren från
allmänheten.

Är den inte satt kör funktionen ändå, men skriver en varning i loggen.

---

## 7. Testa

Testa i den här ordningen. Hoppar du över steg vet du inte vilket led som är
trasigt när det inte fungerar.

### 7.1 Fungerar frågan?

```sh
curl -X POST https://<projekt>.supabase.co/functions/v1/send-reminder \
  -H "Authorization: Bearer <service_role_key>" \
  -H "x-cron-secret: <CRON_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"dry":true}'
```

Svarar `{"ok":true,"dry":true,"antal":0,...}` fungerar kedjan. `antal: 0` är
normalt — ingen brukar köra just nu. Torrkörningen lämnar aldrig ut endpoints;
de är hemligheter och stannar i funktionen.

### 7.2 Finns prenumerationen?

Slå på påminnelser i appen på en riktig telefon, och kolla:

```sql
select * from push_health;
```

`prenumerationer` och `aktiva` ska ha gått upp med ett.

### 7.3 Tvinga fram en riktig push

Vanorna byggs upp först efter några körningar, så vänta inte på dem. Sätt en
lucka som infaller om en kvart, för hand:

```sql
-- Vilken lucka är om 15 minuter, i din tidszon?
select (extract(dow from t)::int * 24 + extract(hour from t)::int) as lucka
from (select (now() at time zone 'Europe/Stockholm') + interval '15 minutes' as t) x;

-- Sätt den på din egen rad (kolla device_id först).
update push_subscriptions
   set slots = array[<lucka>]::smallint[],
       last_drive_date = null, sent_date = null, last_sent_at = null
 where device_id = '<ditt device_id>';
```

**Stäng appen helt** — svep bort den ur app-växlaren, inte bara till
bakgrunden. Kör sedan curl-anropet från 7.1 utan `"dry":true`. Notisen ska
komma inom några sekunder.

Är klockslaget fel: kolla `timezone`-kolumnen. Supabase kör UTC, och
`due_push_reminders` räknar om till radens egen tidszon — en rad med fel
tidszon får notisen en eller två timmar fel beroende på sommartid.

### 7.4 Kontrollera att den städar

```sql
select endpoint, failures, last_error, last_sent_at
from push_subscriptions order by updated_at desc limit 20;
```

`failures` ska vara 0 på fungerande rader. Avinstallera appen på en testtelefon
och kör funktionen igen — raden ska försvinna helt (pushtjänsten svarar 410).

---

## 8. Koppla in det i appen

Tre inkopplingar behövs i `js/app.js`. De är små men ingen av dem är valfri.

```js
import * as push from './push.js';

// 1. Knappen. Måste vara en riktig onclick — se avsnitt 1 om gesten.
$('btnPush').onclick = async () => {
  const r = await push.enable({ deviceId: deviceId(), habits: driving.habits });
  if (!r.ok) toast(r.reason, 8000);
  renderPush();
};

// 2. Nya vanor upp till servern. syncSlots skickar bara när listan ändrats,
//    så den är gratis att anropa varje gång.
driving.addEventListener('start', () => {
  push.syncSlots(driving.habits);
  // 3. "Jag kör redan." Utan den här kommer påminnelsen 07:15 till någon
  //    som satte sig i bilen 07:05, och då stängs notiserna av.
  push.markDroveToday();
});
```

`push.status()` ger allt som behövs för att rita rutan: `supported`, `reason`,
`fix`, `permission`, `subscribed`.

---

## 9. Vanliga fel

| Symptom | Nästan alltid |
|---|---|
| Inget händer på iPhone, knappen gör inget | Appen körs i en Safari-flik, inte från hemskärmen. Avsnitt 1. |
| Systemrutan visas aldrig, inget fel i konsolen | Det ligger ett `await` före `Notification.requestPermission()`. Gesten har gått ut. |
| `InvalidCharacterError` i `atob` | VAPID-nyckeln är trunkerad eller har extra tecken. Den ska vara 87 tecken. |
| `InvalidStateError` från `subscribe()` | Gammal prenumeration med en annan VAPID-nyckel. `enable()` hanterar det — men bara om den publika nyckeln i `js/push.js` faktiskt är den nya. |
| Funktionen svarar 201, ingen notis syns | `push`-lyssnaren saknas i `sw.js`. Avsnitt 4. Det här är det vanligaste felet av alla. |
| `400 Bad Request` från Chrome | Fel eller saknad `VAPID_SUBJECT`. Måste vara `mailto:` eller `https:`. |
| `403 Forbidden` | Nyckeln appen prenumererade med matchar inte den servern signerar med. Byt tillbaka, eller be alla prenumerera om. |
| Notisen kommer på fel klockslag | Fel `timezone` på raden. Servern kör UTC. |
| `Trasiga VAPID-nycklar`, 500 direkt | `VAPID_KEYS` innehåller base64-strängen istället för hela JSON-objektet. |
| Notiser slutade komma efter inloggning | `device_id` bytte från gäst-id till konto-id. `save_push_subscription` hanterar övergången — men bara om appen sparar om prenumerationen efter inloggning. |

---

## 10. Att vara ärlig om

Saker som är värda att veta innan de blir en obehaglig överraskning.

**Vanorna måste läras in först.** `due_push_reminders` skickar bara till luckor
med minst tre registrerade körningar. En ny användare får ingenting alls den
första veckan, och det är rätt — en påminnelse baserad på en enda körning är
en gissning. Men det betyder att funktionen ser trasig ut för den som just
installerat appen. Säg det i UI:t.

**Vi kan inte veta att bilen står stilla.** `markDroveToday()` bygger på att
appen faktiskt öppnades under körningen. Den som kör utan appen — alltså exakt
den person påminnelsen finns för — kommer ändå att få notisen dagen efter en
sådan körning. Det går inte att lösa i en webbapp.

**Taket är tre notiser om dygnet, minst 90 minuter isär.** Den som kör mycket
har många luckor. Spärren finns i `due_push_reminders` och är det enda som
skyddar kanalen — sex notiser om dagen och användaren stänger av dem, och då
är hela funktionen borta.

**Inga notiser före klockan fem lokalt.** En felinlärd nattlucka får aldrig
väcka någon 03:00.

**Kryptobiblioteket är inte granskat av kryptografer.** `@negrel/webpush`
skriver det själv i sin README. Nyckelhärledningen är kontrollerad mot
pseudokoden i RFC 8291 §3.4 och stämmer rad för rad, och biblioteket använder
bara Web Crypto-primitiver — men en fullständig granskning är inte gjord, av
oss eller någon annan. Det gäller i praktiken de flesta web push-bibliotek.

**Vi avviker något från RFC 8291 §2.** Specen beskriver att servern genererar
ett nytt ECDH-nyckelpar per meddelande; biblioteket genererar ett per
serverobjekt. Saltet slumpas per meddelande, så nyckel och nonce blir ändå
unika — men för att minska avvikelsen byggs serverobjektet om vid varje
körning istället för att ligga kvar mellan anrop. Nyckeln roterar därmed var
femte minut.

**Ej verifierat i den här omgången:** hur Apples pushtjänst
(`web.push.apple.com`) beter sig i praktiken vid rate limiting, och om den
returnerar 404 eller 410 när en hemskärmsapp avinstalleras. Koden hanterar
båda statuskoderna likadant, så utfallet blir rätt oavsett — men den som vill
veta säkert får titta i `last_error` efter en riktig avinstallation.

**Retry-After respekteras inte aktivt.** Vid 429 loggas huvudet men vi väntar
inte in det — cron kommer tillbaka om fem minuter ändå. Dyker 429 upp
återkommande i loggen är det `SAMTIDIGA` i `index.ts` som behöver sänkas.
