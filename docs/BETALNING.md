# Betalningar i Polisvakt — checklista från noll till fungerande Stripe

## Läs det här först: vad som är byggt och vad som är overifierat

**Ingenting i den här kedjan har körts mot ett riktigt Stripe-konto.** Jag har
inget Stripe-konto, kan inte skapa ett, och kan därför inte skicka en enda
webhook genom funktionen. Koden är skriven mot Stripes dokumentation och mot
resten av det här repot — den är inte bevisad.

Konkret betyder det:

| Del | Status |
|---|---|
| `supabase/stripe.sql` | Skriven. **Aldrig körd mot databasen.** Syntaxen är inte verifierad av Postgres. |
| `supabase/functions/stripe-webhook/index.ts` | Skriven. **Aldrig kompilerad, aldrig deployad.** Deno finns inte på maskinen den skrevs på, så inte ens `deno check` har körts. |
| `js/betalning.js` | Skriven. **Aldrig körd i webbläsare, och inte inkopplad i appen** — se avsnitt 4. |
| Signaturverifiering | Följer Stripes dokumenterade mönster för Deno. Aldrig testad mot en riktig signatur. |
| Idempotens | Logiken är genomgången rad för rad. Aldrig testad mot en riktig omsändning. |
| Beloppen och momsen | Räknade ur `js/plans.js`. Kontrollräkna dem ändå, avsnitt 2. |
| Moms- och konsumenträttsavsnitten | Allmän orientering från en icke-jurist. Avsnitt 13 listar det jag är osäker på. |

Därför står **avsnitt 7 (Testa)** där det står, och därför är det inte
valfritt. Räkna med att något går fel första gången. Det som är byggt för att
göra fel *synliga* istället för tysta är revisionsloggen `payment_events` och
vyerna `payment_problems`, `stripe_health` och `stripe_orphans`.

Räkna med **45–60 minuter** för testläget. Live tar längre tid, eftersom
Stripe ska granska företaget.

---

## Så hänger det ihop

```
Appen                       Stripe                    Supabase
─────                       ──────                    ────────
Kund väljer nivå
  └─ öppnar betallänken
     ?client_reference_id=<device_id>
                            Kunden betalar
                            Skickar webhook  ───────▶ stripe-webhook
                                                        │ 1. verifierar signaturen
                                                        │ 2. claim_payment_event (idempotens)
                                                        │ 3. läser nivå + månader
                                                        │ 4. set_paid_until / add_paid_months
                                                        └─ finish_payment_event (revision)
Appen frågar
get_subscription  ◀──────────────────────────────────── paid_until
  └─ släpper igenom
```

Två saker är värda att förstå innan du börjar, för allt som går fel senare är
någon av dem:

**1. `client_reference_id` följer bara med på den första betalningen.** Vid
checkout sparar webhooken därför Stripes kund-id (`cus_...`) på raden i
`subscribers`. Alla framtida förnyelser hittar hem via det id:t och ingenting
annat. Går kopplingen sönder slutar förnyelser fungera *tyst* — det är därför
vyn `payment_problems` finns och därför du ska titta i den.

**2. Klienten kan inte sätta sin egen betalstatus.** Fyra oberoende spärrar:
ingen UPDATE-policy på `subscribers`, INSERT-policyn kräver att `paid_until` är
null, `set_paid_until` har EXECUTE indraget från `anon` och `authenticated`, och
triggern i `supabase/stripe.sql` avvisar skrivningen oavsett vad policyerna
säger. Efterkontroll 1 i avsnitt 5 testar den sista.

---

## 1. Skapa Stripe-kontot

1. <https://dashboard.stripe.com/register>. Välj **Sverige** som land. Landet
   går inte att ändra sen — kontot måste flyttas manuellt av Stripe.
2. Kontot startar i **testläge**. Allt i avsnitt 2–7 görs i testläge.
   Testläget känns igen på att nycklarna börjar på `sk_test_` / `pk_test_`.
3. För att aktivera live behövs:
   - Organisationsnummer (enskild firma går bra, personnummer används då)
   - Företagsadress och verksamhetsbeskrivning
   - Bankkonto (svenskt IBAN, `SE...`)
   - Legitimation för ägaren
   - En publik webbadress där tjänsten, priset och villkoren syns

**Valuta:** SEK under Inställningar → Betalningar → Valutor. Ett svenskt konto
får det automatiskt. Prisuppslaget i `stripe_price_map` är seedat med `sek` —
säljer du i annan valuta måste den tabellen kompletteras.

**Betalmetoder:** kort räcker för att komma igång och är den metod som säkert
klarar automatiska månadsdragningar. *Osäkert:* om Swish går att använda för
**återkommande** dragningar via Stripe just nu — källorna säger emot varandra.
Kolla vad som faktiskt går att bocka i på ditt konto innan du lovar Swish i
appen. Kör kort först.

> Slår du på **Klarna eller banköverföring**: de är fördröjda betalmetoder.
> Kassan blir klar innan pengarna kommit. Webhooken hanterar det — den ger
> ingen tillgång förrän `payment_status` är `paid` — men då **måste** du också
> prenumerera på `checkout.session.async_payment_succeeded` i avsnitt 6, annars
> får kunden aldrig sin tillgång.

---

## 2. Produkter och priser

**Produktkatalog → Lägg till produkt.** Sex priser: tre månadsprenumerationer
och tre förskott på sex månader.

Priserna i `js/plans.js` är **inklusive moms** — så ska konsumentpriser anges i
Sverige. Ange exakt samma siffror i Stripe och markera dem som inklusive skatt
(avsnitt 10, "Stripe Tax").

| Produkt i Stripe | Pris | Öre (det Stripe vill ha) | Typ | Varav moms 25 % |
|---|---|---|---|---|
| Polisvakt Bas | 99 kr | `9900` | Återkommande, månad | 19,80 kr |
| Polisvakt Plus | 149 kr | `14900` | Återkommande, månad | 29,80 kr |
| Polisvakt Pro | 199 kr | `19900` | Återkommande, månad | 39,80 kr |
| Polisvakt Bas 6 mån | 475 kr | `47500` | Engångs | 95,00 kr |
| Polisvakt Plus 6 mån | 715 kr | `71500` | Engångs | 143,00 kr |
| Polisvakt Pro 6 mån | 955 kr | `95500` | Engångs | 191,00 kr |

Förskotten är sex månader minus 20 %, avrundat precis som `priceFor()` i
`js/plans.js`: `round(99 × 6 × 0,8) = 475`, `round(149 × 6 × 0,8) = 715`,
`round(199 × 6 × 0,8) = 955`. Avviker Stripe från appen med en krona hör någon
av sig, och de har rätt.

**Ändrar du ett pris** måste du också uppdatera `stripe_price_map` i
databasen — se avsnitt 5. Annars slutar reservvägen fungera.

### Metadata — hoppa inte över det här

Webhooken gissar aldrig vilken nivå eller hur många månader ett köp gäller.
Den läser metadata på priset.

På **varje pris**, under Metadata:

| Nyckel | Värde | Gäller |
|---|---|---|
| `plan` | `bas`, `plus` eller `pro` | Alla sex priserna |
| `manader` | `6` | Bara de tre förskottspriserna |

Värdena i `plan` måste stavas exakt som `id` i `PLANS` i `js/plans.js`.

> Metadata kan ligga på produkten istället för priset — webhooken tittar på
> båda, priset vinner. Ligger den på produkten räcker det en gång per nivå.

**Om du glömmer:** webhooken faller tillbaka på beloppet via tabellen
`stripe_price_map`, kunden får rätt tillgång ändå, och raden i `payment_events`
får en `error`-text som säger vilket pris som saknar metadata. Det är en
räddning, inte en ursäkt — reserven bygger på att beloppen står i tabellen, och
den dagen du ändrar ett pris utan att ändra tabellen är den borta.

---

## 3. Betallänkar

En länk per pris, alltså sex stycken. **Betallänkar → Ny**.

1. Välj priset. Antal: fast, 1.
2. **Efter betalning → Omdirigera till en sida.** Peka på appens adress,
   till exempel `https://polisvakt.netlify.app/?betalt=1`. Utan omdirigering
   står kunden kvar på Stripes kvittosida och undrar var appen tog vägen.
3. Under **Alternativ**: slå på att samla in e-postadress. Den behövs för
   kvitto, och den är det enda kunden kan läsa upp i telefon när något ska
   lagas för hand.
4. Kopiera länken.

### client_reference_id

Länken måste öppnas med enhetens id:

```
https://buy.stripe.com/xxxxxxxx?client_reference_id=<device_id>
```

Det gör `checkoutUrl()` i `js/betalning.js` automatiskt. Du behöver inte lägga
till något i länken du klistrar in — **klistra in den rena länken**, precis som
Stripe ger den. Lägger du till parametern själv skrivs den över ändå.

**Öppna aldrig en betallänk utan parametern** när du testar. Betalningen går
igenom, webhooken hittar ingen enhet, och du får en föräldralös rad att laga
för hand (avsnitt 8).

---

## 4. Var länkarna ska in

De sex länkarna klistras in i **`js/betalning.js`**, högst upp:

```js
export const PAYMENT_LINKS = {
  bas:  { manad: 'https://buy.stripe.com/...', halvar: 'https://buy.stripe.com/...' },
  plus: { manad: 'https://buy.stripe.com/...', halvar: 'https://buy.stripe.com/...' },
  pro:  { manad: 'https://buy.stripe.com/...', halvar: 'https://buy.stripe.com/...' },
};
```

`manad` = månadsprenumerationen, `halvar` = sexmånadersförskottet. Nycklarna
måste stavas som `id` i `PLANS` (`js/plans.js`). Filen kontrollerar sig själv
vid start och skriver i konsolen om något är halvifyllt, felstavat eller
fortfarande är en `test_`-länk i drift.

> `js/config.js` har fortfarande fältet `stripePaymentLink` med plats för
> **en** länk. Det fältet är den gamla vägen och används av `js/billing.js`.
> Lämna det som det är, eller lägg in Plus månadslänk där som reserv — det
> skadar inte, och appen kan ta betalt på den vägen redan innan inkopplingen
> nedan är gjord.

### Koppla in de sex länkarna

`js/betalning.js` importeras inte av något ännu. Att koppla in den kräver två
ändringar i `js/app.js`, som ägs av någon annan. Ändringarna är dessa:

**1.** Bland importerna högst upp:

```js
import { checkoutUrl as betalLank } from './betalning.js';
```

**2.** Byt ut `startCheckout()` (ligger under `/* ===== Betalning ===== */`):

```js
function startCheckout(prepay = false) {
  const plan = settings.plan || 'plus';
  // Faller tillbaka på den enda länken i CONFIG om de sex inte är ifyllda än.
  const url = betalLank(plan, { prepay }) || billing.checkoutUrl();
  if (!url) {
    toast('Betallänk saknas. Lägg in dina Stripe-länkar i js/betalning.js.', 6000);
    return;
  }
  window.open(url, '_blank', 'noopener');
}
```

Förskottsrutan i `renderPlans()` är i dag bara en informationstext. Ska den gå
att köpa behöver den bli klickbar och anropa `startCheckout(true)`.

---

## 5. Kör SQL:en

Supabase → SQL Editor. Tre filer, **i den här ordningen**:

1. `supabase/schema.sql` — tabellen `subscribers`, `get_subscription`, koderna
2. `supabase/billing.sql` — `payment_events`, idempotensen, `set_paid_until`
3. `supabase/stripe.sql` — spärren på `paid_until`, prisuppslaget, lagningen

Alla tre går att köra om hur många gånger som helst. `stripe.sql` avbryter med
ett tydligt fel om de två första inte körts.

### Efterkontroll 1 — kan en klient ge sig själv gratis prenumeration?

**Det här är den enskilt viktigaste kontrollen i hela guiden.** Kör den, läs
svaret, gå inte vidare förrän det ser rätt ut.

```sql
set local role anon;
insert into public.subscribers (device_id, paid_until)
values ('spärrtest', now() + interval '10 years');
reset role;
```

Förväntat: ett fel som börjar med
`paid_until sätts bara av Stripe-webhooken.`

**Kommer raden in istället: stanna.** Då kan vem som helst med anon-nyckeln —
som ligger öppet i appens källkod — ge sig själv livstids prenumeration, och
allt annat i betalningskedjan är meningslöst. Kontrollera att triggern
`subscribers_guard_paid_until` verkligen skapades:

```sql
select tgname, tgenabled from pg_trigger
where tgrelid = 'public.subscribers'::regclass and not tgisinternal;
```

Städa efter dig om raden mot förmodan kom in:
`delete from public.subscribers where device_id = 'spärrtest';`

### Efterkontroll 2 — ligger EXECUTE kvar hos fel roll?

```sql
select p.proname, coalesce(r.rolname, 'PUBLIC') as roll
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
left join lateral aclexplode(p.proacl) a on true
left join pg_roles r on r.oid = a.grantee
where n.nspname = 'public'
  and p.proname in ('set_paid_until','add_paid_months','claim_payment_event',
                    'finish_payment_event','link_stripe_customer',
                    'device_for_stripe_customer','set_sub_status',
                    'stripe_plan_for_amount','repair_payment_event',
                    'subscriber_by_email')
order by 1, 2;
```

Dyker `anon`, `authenticated` eller `PUBLIC` upp: kör revoke-blocken i
`billing.sql` och `stripe.sql` igen. Postgres delar ut EXECUTE till PUBLIC på
varje ny funktion, och en revoke som bara nämner `anon` tar bort en rättighet
den aldrig hade.

### Efterkontroll 3 — stämmer prisuppslaget med Stripe?

```sql
select amount_ore, currency, plan, months, note
from public.stripe_price_map order by amount_ore;
```

Sex rader, och beloppen ska stämma exakt med tabellen i avsnitt 2. Har du satt
andra priser i Stripe:

```sql
insert into public.stripe_price_map (amount_ore, currency, plan, months, note)
values (12900, 'sek', 'bas', null, 'Bas 129 kr/mån')
on conflict (amount_ore, currency) do update
  set plan = excluded.plan, months = excluded.months, note = excluded.note;
```

### Om PostgREST inte hittar de nya funktionerna

```sql
notify pgrst, 'reload schema';
```

---

## 6. Deploya webhooken och koppla endpointen

Kräver Supabase CLI: `npm install -g supabase` (eller `scoop install supabase`).

```bash
supabase login
supabase link --project-ref livvehyqowmcafnisxho

supabase secrets set STRIPE_SECRET_KEY=sk_test_...
supabase functions deploy stripe-webhook --no-verify-jwt
```

**`--no-verify-jwt` är obligatoriskt.** Stripe skickar ingen Supabase-JWT och
kan inte göra det. Utan flaggan avvisas varje anrop med 401 innan koden körs,
och Stripe-panelen fylls med röda leveranser. Autentiseringen sker istället
genom signaturen i `stripe-signature`-huvudet, som funktionen verifierar mot
`STRIPE_WEBHOOK_SECRET` på den råa kroppen.

`SUPABASE_URL` och `SUPABASE_SERVICE_ROLE_KEY` sätts **inte** — de injiceras av
plattformen. Service role-nyckeln får aldrig hamna i något under `js/`.

Adressen blir:

```
https://livvehyqowmcafnisxho.supabase.co/functions/v1/stripe-webhook
```

### Endpointen i Stripe

**Utvecklare → Webhooks → Lägg till endpoint.** URL enligt ovan. Händelser att
lyssna på — **alla åtta**:

| Händelse | Vad webhooken gör |
|---|---|
| `checkout.session.completed` | Kopplar kund → enhet, sätter `paid_until` |
| `checkout.session.async_payment_succeeded` | Samma, för Klarna/banköverföring som betalas senare |
| `checkout.session.async_payment_failed` | Loggar. Ingen tillgång hade getts, så inget dras tillbaka |
| `customer.subscription.created` | Sätter `paid_until` till periodens slut |
| `customer.subscription.updated` | Nivåbyte, betalning som kom ikapp |
| `customer.subscription.deleted` | Enda gången `paid_until` flyttas **bakåt** |
| `invoice.paid` | Förnyelsen. Den som håller kunder igång månad efter månad |
| `invoice.payment_failed` | Noterar `past_due`. Drar **inte** in tillgången |
| `charge.dispute.created` | Loggar tvisten så betalhistoriken finns när bevis ska in |

Kopiera **signeringshemligheten** (`whsec_...`), sätt den och deploya om:

```bash
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
supabase functions deploy stripe-webhook --no-verify-jwt
```

> **Test och live har olika hemligheter.** Den vanligaste orsaken till att allt
> slutar fungera dagen man går live är att `whsec` fortfarande pekar på
> testendpointen. Symptomet är `400 Ogiltig signatur` i funktionsloggen.

**API-version:** Stripe skickar händelserna i den version endpointen är
inställd på. Webhooken hanterar både gammal och ny form av `current_period_end`
och `invoice.subscription` — de fälten flyttade i `2025-03-31.basil` — men
fastnar du i felsökning är endpointens API-version det första att kontrollera.

---

## 7. Testa

Ingen del av det här har körts. Gå igenom alla fem stegen.

### 7.1 Lyckoscenariot — prenumeration

Öppna en testbetallänk med en påhittad enhet:

```
https://buy.stripe.com/test_xxxxx?client_reference_id=test-enhet-1
```

| Kort | Vad det testar |
|---|---|
| `4242 4242 4242 4242` | Går igenom direkt |
| `4000 0025 0000 3155` | Kräver 3D Secure (det normala i EU) |
| `4000 0000 0000 9995` | Nekas — täckning saknas |
| `4000 0000 0000 0341` | Kortet sparas men dragningen misslyckas senare |

Valfritt framtida utgångsdatum, valfri CVC, valfritt postnummer. Kontrollera
sedan:

```sql
select event_id, type, status, device_id, paid_until, error
from payment_events order by received_at desc limit 10;

select device_id, plan, sub_status, paid_until, stripe_id
from subscribers where device_id = 'test-enhet-1';
```

Ska stämma:

- `status` = `processed`
- `plan` = rätt nivå. Är den `null` saknas metadata **och** beloppet finns inte
  i `stripe_price_map`
- `paid_until` ≈ en månad fram, **plus ett dygn** (respiten, se avsnitt 12)
- `stripe_id` = ett `cus_...`. **Är den tom slutar förnyelser fungera om en
  månad, tyst.** Det här fältet är viktigare än det ser ut.
- `error` ska vara tom. Står det något om "härledd ur beloppet" saknas metadata
  på priset — gå tillbaka till avsnitt 2

### 7.2 Lyckoscenariot — sexmånadersförskottet

Samma sak med en förskottslänk och `client_reference_id=test-enhet-2`.
`paid_until` ska hamna ungefär sex månader fram. Blir det en månad har
webhooken behandlat det som en prenumeration; blir det `orphan` saknas
`manader` i metadata och beloppet finns inte i `stripe_price_map`.

### 7.3 Dubbletten — den som kostar pengar om den är trasig

I webhookloggen: välj en levererad händelse och tryck **Skicka om**.

Svaret ska bli `{"ok":true,"dubblett":true}` och `paid_until` ska **stå still**.

Gör om det på en **förskottsbetalning**. Där är logiken additiv, och en trasig
idempotens ger kunden sex extra månader gratis per omsändning. Flyttar sig
`paid_until` är `claim_payment_event` trasig — kontrollera att `payment_events`
har primärnyckel på `event_id`.

### 7.4 Förnyelsen — utan att vänta en månad

**Utvecklare → Testklockor.** Skapa en klocka, koppla en testkund till den, gör
en prenumeration och spola fram 32 dagar. `invoice.paid` kommer på riktigt och
`paid_until` ska flyttas fram. Det är det här som avgör om du har återkommande
intäkter eller bara ett engångsköp med extra steg.

### 7.5 Felvägarna

```bash
supabase functions serve stripe-webhook --no-verify-jwt --env-file .env.local
stripe listen --forward-to http://localhost:54321/functions/v1/stripe-webhook
stripe trigger checkout.session.completed
stripe trigger invoice.payment_failed
```

`stripe listen` skriver ut en **egen** `whsec_` — den ska stå i `.env.local`,
inte panelens.

`stripe trigger` skapar syntetiska objekt **utan** `client_reference_id`. De
ska landa som `orphan`. Det testar felhanteringen, inte lyckoscenariot.

Testa också att en **falsk** webhook avvisas:

```bash
curl -X POST https://livvehyqowmcafnisxho.supabase.co/functions/v1/stripe-webhook \
  -H 'Content-Type: application/json' \
  -H 'stripe-signature: t=1,v1=fusk' \
  -d '{"id":"evt_fusk","type":"invoice.paid"}'
```

Svaret ska vara `400 Ogiltig signatur`, och **ingen rad** ska ha skapats i
`payment_events`. Blir svaret `200` är endpointen öppen för vem som helst på
internet att ge sig själv en prenumeration genom att posta JSON.

---

## 8. Drift: vad du tittar på och hur du lagar

### Varje vecka, tre frågor

```sql
select * from public.stripe_health;
select * from public.payment_problems;
select * from public.stripe_orphans;
```

`stripe_health` ska visa noll på `foraldralosa`, `fel`, `fastnade` och
`utan_giltig_niva`, och `senaste_handelse` ska inte vara äldre än din senaste
betalning. `payment_problems` ska vara tom.

| `status` | Betyder | Åtgärd |
|---|---|---|
| `orphan` | Betalning som inte gick att koppla till en enhet | Se nedan |
| `error` | Tekniskt fel | Läs `error`, kolla funktionsloggen, skicka om från Stripe |
| `pending` äldre än 15 min | Fastnat mitt i | Skicka om händelsen från Stripe-panelen |

### Laga en föräldralös betalning

1. Hitta enheten. Har du bara e-postadressen kunden betalade med:

   ```sql
   select * from public.subscriber_by_email('kund@example.com');
   ```

   Ger den ingenting: leta upp `cus_...` i Stripe och fråga kunden efter
   enhets-id:t, som visas i appens inställningar.

2. Koppla och öppna händelsen för omsändning:

   ```sql
   select public.repair_payment_event('evt_...', '<device_id>');
   ```

   Funktionen svarar med vad den gjorde och vad du ska göra härnäst. Den delar
   medvetet **inte** ut tid själv — tiden ska komma från Stripes egna uppgifter,
   annars blir revisionsloggen en berättelse om vad vi trodde, inte vad som hände.

3. **Stripe → Utvecklare → Webhooks → händelsen → Skicka om.** Nu hittar
   webhooken hem, och `payment_events` ska bli `processed`.

4. Fungerar det ändå inte — ge tiden för hand och skriv varför i din egen
   bokföring:

   ```sql
   select public.add_paid_months('<device_id>', 6, 'plus');   -- förskottet
   select public.set_paid_until('<device_id>', now() + interval '1 month',
                                'plus', null, 'active', 'forlang');
   ```

### Återbetalning eller uppsägning

Sker i Stripe-panelen. Uppsägningen kommer som
`customer.subscription.deleted` och webhooken sätter `paid_until` till
periodens slut. En **återbetalning** skickar däremot ingen händelse som drar in
tillgången — vill du ta bort den direkt:

```sql
select public.set_paid_until('<device_id>', now(), null, null, 'refunded', 'exakt');
```

`'exakt'` är enda läget som flyttar `paid_until` bakåt.

---

## 9. Gå live

1. Aktivera kontot (Stripe granskar, timmar till några dagar).
2. Skapa produkter, priser **med metadata** och betallänkar på nytt i
   liveläget. Testobjekt följer inte med.
3. Ny webhook-endpoint i liveläget → ny `whsec_`, samma åtta händelser.
4. ```bash
   supabase secrets set STRIPE_SECRET_KEY=sk_live_...
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
   supabase functions deploy stripe-webhook --no-verify-jwt
   ```
5. Byt ut testlänkarna mot livelänkarna i `js/betalning.js`. Konsolen varnar om
   en `test_`-länk blivit kvar.
6. **Köp en riktig prenumeration med eget kort.** Kontrollera raden i
   `subscribers`, säg sedan upp och återbetala dig själv. Ett riktigt köp
   hittar saker inget testläge gör.
7. Slå på e-postkvitton: Inställningar → Kvitton från kunder.
8. Slå på **kundportalen** (Inställningar → Kundportal) och länka till den från
   appens inställningar. Uppsägning ska vara minst lika lätt som att teckna, och
   det tar bort merparten av alla supportärenden.

---

## 10. Moms

**Digitala tjänster till svenska konsumenter beskattas med 25 % moms.** Appen är
en digital tjänst — inget av undantagen (böcker, tidningar, persontransport) är
i närheten.

Priserna 99 / 149 / 199 kr är **inklusive moms**. Konsumentpriser ska enligt
prisinformationslagen anges som det totalpris kunden faktiskt betalar. Din
intäkt före Stripes avgift är alltså 79,20 / 119,20 / 159,20 kr.

- **Momsregistrering.** Sedan 2025 går gränsen för att slippa momsregistrera sig
  vid **120 000 kr** i omsättning per år (tidigare 80 000). Under gränsen kan du
  välja att stå utanför, men då får du inte dra av ingående moms — och du måste
  ändå ha koll på när du passerar den. *Verifiera aktuell siffra hos
  Skatteverket.*
- **Kunder i andra EU-länder.** Köparlandets momssats gäller, med en tröskel på
  10 000 EUR per år för hela EU-försäljningen sammanlagt. Över den redovisar du
  enklast via **OSS** hos Skatteverket. Polisvakt är byggd för Västmanland, så
  det blir aktuellt först vid expansion.
- **Bokföring.** Räkenskapsinformation ska sparas i sju år. Stripes
  betalningshistorik räknas, men exportera den regelbundet — förlitar du dig på
  att ett konto hos en leverantör finns kvar om sju år är det inte du som
  bestämmer. `revenue_by_month` i databasen är din egen kopia av samma siffror.

Jag är inte revisor. Stäm av upplägget med en bokföringsbyrå före första
momsdeklarationen.

### Stripe Tax — ja eller nej?

**Rekommendation: slå på det**, inte främst för Sveriges skull utan för att
slippa bygga om pris- och kvittohanteringen den dag du säljer utanför landet.

1. Inställningar → Skatt → ange var företaget hör hemma och registrera din
   svenska momsregistrering.
2. Sätt **skattebeteende** på priserna till **inklusive skatt**. Väljer du
   "exklusive" lägger Stripe 25 % ovanpå 99 kr och kunden får betala 124 kr.
   Skattebeteendet går **inte att ändra på ett befintligt pris** — då måste ett
   nytt pris skapas och alla betallänkar göras om. Sätt det rätt från start
   även om du hoppar över Stripe Tax i övrigt.
3. Slå på **Beräkna skatt automatiskt** i varje betallänk.
4. Sätt produktens skattekategori till elektroniskt levererade tjänster.

Stripe Tax kostar en andel av varje transaktion utöver transaktionsavgiften.
*Kolla aktuell prislista* — jag uppger ingen siffra eftersom den ändras.

---

## 11. Vad en konsumentprenumeration kräver

Kunderna är privatpersoner och försäljningen sker på distans. Då gäller **lagen
(2005:59) om distansavtal och avtal utanför affärslokaler**, plus
marknadsföringslagen och prisinformationslagen.

### Innan köp — i appen, inte bara i en villkorssida

- Företagets namn, organisationsnummer, adress, e-post och telefon
- Vad tjänsten är och vad den inte är
- **Totalpris inklusive moms**, och att det är **per månad tills vidare**
- Att prenumerationen **förnyas automatiskt** och hur man säger upp den
- Löptid och kortaste bindningstid (för förskottet: sex månader)
- Ångerrätten, hur den utövas och Konsumentverkets ångerblankett
- Att tvister kan prövas av **ARN**, med adress, och att ni följer besluten

> **Ta inte med EU:s ODR-plattform.** Den stängdes 20 juli 2025 och länken är
> död. Många villkorsmallar har den kvar. Hänvisa till ARN, och till ECC
> Sverige för kunder i andra EU-länder.

### Beställningsknappen

Vid distansavtal på nätet måste det framgå uttryckligen att beställningen
**medför betalningsskyldighet**. `knappText()` i `js/betalning.js` returnerar
därför "Betala 99 kr/mån" och inte "Fortsätt". Kontrollera dessutom själv hur
knappen är formulerad på svenska i **Stripes** kassa.

### Ångerrätt

Huvudregeln: **14 dagar** från avtalets ingående. För digitala tjänster faller
den bort om kunden uttryckligen samtyckt till att leveransen påbörjas under
ångerfristen **och** uttryckligen bekräftat att ångerrätten därmed går
förlorad. Båda delarna krävs och ska dokumenteras.

Praktiskt:

- Appen har redan **5 dagars gratis provperiod**. Kunden har provat innan han
  betalar, vilket gör ångerfall ovanliga.
- **Enklaste och tryggaste linjen: återbetala utan diskussion inom 14 dagar.**
  99 kr är inte värt en tvist hos ARN, och generositet är bra marknadsföring.
  Skriv in det i villkoren så blir undantagsreglerna en akademisk fråga.
- Ångerrätten gäller **nya avtal**, inte automatiska förnyelser.

---

## 12. Felsökning

| Symptom | Trolig orsak |
|---|---|
| `401` på webhooken | Deployad utan `--no-verify-jwt` |
| `400 Ogiltig signatur` | Fel `whsec` — oftast test mot live. Deploya om efter `secrets set` |
| `500 Servern är inte konfigurerad` | En hemlighet saknas. `supabase secrets list` |
| Betalning gick igenom, `paid_until` orörd | Kolla `stripe_orphans`. Troligen saknade länken `client_reference_id` |
| `paid_until` satt till 1970 | Periodfältet lästes fel. Kolla endpointens API-version |
| `paid_until sätts bara av Stripe-webhooken` i loggen | Något anropar som `anon`. Webhooken ska köra med service role-nyckeln |
| `paid_until skulle flyttas ... framåt i ett enda steg` | Sekunder tolkade som millisekunder. Se `periodSlut()` |
| `plan` är `null` | Metadata `plan` saknas **och** beloppet finns inte i `stripe_price_map` |
| Förskottsköp ger ingen tid | Metadata `manader` saknas **och** beloppet finns inte i `stripe_price_map` |
| Klarna-köp ger aldrig tillgång | `checkout.session.async_payment_succeeded` saknas i endpointens händelselista |
| `rpc ... gav 404` | PostgREST har inte laddat om. `notify pgrst, 'reload schema';` |
| `rpc ... gav 403` | Rättigheterna i avsnitt 5, efterkontroll 2 |
| Dubbla månader vid omsändning | `claim_payment_event` fungerar inte — kolla primärnyckeln på `payment_events` |

Funktionsloggen: Supabase → Edge Functions → stripe-webhook → Logs.
Leveranshistoriken: Stripe → Utvecklare → Webhooks → din endpoint.

### Tre beteenden som ser ut som buggar men inte är det

**`paid_until` ligger ett dygn efter periodens slut.** Medvetet. Stripe drar
kortet på förfallodagen men fakturan kan ta timmar. Utan respit får en betalande
kund betalväggen mitt under körning medan pengarna är på väg. Konstanten heter
`RESPIT_TIMMAR` i webhooken.

**En nekad betalning stänger inte av kunden direkt.** Också medvetet. Stripe
gör om försöket i upp till ett par veckor och de flesta fall löser sig.
`paid_until` har redan ett slutdatum — går tiden ut utan betalning stängs appen
av av sig själv.

**Appen kan inte uppdatera en befintlig rad i `subscribers`.** Det finns ingen
UPDATE-policy, med flit. Följden är att `#syncUp()` i `js/billing.js` misslyckas
tyst när raden redan finns. Det är rätt beteende: serverns `trial_start` ska
vinna över klientens, annars räcker det att rensa webbläsardata för en ny
provperiod.

---

## 13. Vad jag inte är säker på

Utöver att **ingenting är kört** (se första avsnittet):

1. **Momsgränsen på 120 000 kr.** Höjdes från 80 000 kr, men verifiera den
   aktuella siffran och villkoren hos Skatteverket.
2. **Swish för återkommande dragningar via Stripe.** Källorna säger emot
   varandra. Kolla vad som går att slå på i just ditt konto.
3. **Stripe Tax-priset.** Ändras. Läs den aktuella prislistan.
4. **Ångerrätt vid sexmånadersförskottet.** Att återbetala oförbrukad tid är
   det rimliga, men jag har inte hittat ett entydigt besked. Fråga Hallå
   konsument innan du säljer många av dem.
5. **Krav på uppsägningsknapp i svensk rätt.** Jag känner inte till något
   sådant krav i dag, men reglerna rör på sig i EU. Bygg knappen ändå.
6. **Exakt formulering på Stripes kassaknapp på svenska.** Lagkravet är tydligt;
   att Stripes översättning uppfyller det har jag inte verifierat. Titta själv.
7. **Om Stripe kopierar en betallänks metadata till kassasessionen.** Jag
   förlitar mig inte på det — webhooken hämtar `line_items` från priset — men om
   du hört annat är det inte därifrån webhooken läser.
