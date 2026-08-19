# Kräver dig


## 0. Netlify — utrullningar är pausade  ← BLOCKERAR ALLT ANNAT

Ditt Netlify-team har gått över till driftkrediter. Sajten ligger kvar och
fungerar, men **nya utrullningar går inte att göra**. Utrullningsrutan är
borttagen ur gränssnittet.

> "Your published sites are still live, but production deploys are paused.
> Upgrade your team or wait for your next billing cycle to resume."

Antingen uppgraderar du teamet eller väntar på nästa faktureringsperiod. Det
är ett köp, och sådana gör jag inte åt dig.

**Varför det brådskar:** version 29 innehåller fixarna som gör att rapporter
från *andra* förare hörs. Den version som ligger live nu, v27, graderar dem
som osäkra och tystar dem — hela poängen med ett delat flöde. Fixen är byggd,
testad och paketerad, och går ut samma minut som utrullningar fungerar igen.

Databasdelen är redan körd skarpt, så inget mer behövs där.

---

Resten. Ingen av dem kan jag göra åt dig, och för varje står det varför.

## 1. Testa en riktig notis (5 min)

Serversidan är klar och verifierad — nycklar, edge-funktion, cron var femte
minut. Det enda som återstår är att ta emot en notis på en riktig telefon.

1. **iPhone: appen måste ligga på hemskärmen.** Apple tillåter inte Web Push
   till en Safari-flik. Android och dator klarar vanlig flik.
2. Logga in.
3. Inställningar → *Påminnelse när du kör* → **Tillåt notiser**.
4. Kör en gång så appen lär sig tiden.

Kommer ingen notis: säg till, då läser jag funktionens loggar.

## 2. Dashcam i bil (15 min)

Verifierat mot en syntetisk kameraström — start, inspelning, sparat klipp som
går att spela upp. Tre saker kräver riktig hårdvara:

- att **bakkameran** väljs, inte selfiekameran (spärren är byggd och testad,
  men bara mot påhittade kameror)
- att **två kameror samtidigt** fungerar, eller faller tillbaka snyggt
- hur **varm** telefonen blir efter en halvtimme

Värmen är den jag skulle hålla ögonen på. Appen har numera en vakt som sänker
kvalitet och bildfrekvens när den märker att telefonen inte hinner med, men
den har aldrig fått känna på en riktig telefon i solen.

## 3. Betalning — sex länkar

`docs/BETALNING.md` är nu en checklista. Webhook, databasdel och klientkod är
byggda och väntar bara på länkarna.

Sex betallänkar skapas i Stripe och klistras in i **`js/betalning.js`** — inte
i `js/config.js`, det ändrades i natt.

Jag skapar inte konton och rör inte betalningsuppgifter; det är din del.
Signaturverifieringen är den kritiska biten i det jag byggt: en overifierad
webhook låter vem som helst ge sig själv gratis prenumeration genom att posta
JSON till adressen.

Ingenting av betalningskedjan är kört skarpt. Jag har inget Stripe-konto och
har aldrig kunnat verifiera en signatur.

## 4. Facebook-gruppen (behöver en människa i gruppen)

Mottagarsidan är klar och inkopplad: tolkning, dubblettkoll, geokodning,
kartmarkering, uppläsning. Den väntar bara på ett flöde.

Det finns ingen laglig teknisk väg in i en privat grupp — Meta stängde
Groups API 2024. Den väg som fungerar: be **någon** i gruppen, inte
nödvändigtvis ägaren, spegla inläggen till en Telegram-kanal. Telegram har ett
riktigt bot-API. Säg till när någon vill hjälpa till, så är kopplingen klar på
en kvart.

Kör alltid torrkörning först innan du släpper på ett flöde. I konsolen:

    polisvakt.ingest(inlägg, { dryRun: true })

Den visar exakt vad som hade hänt utan att skriva något.

## 5. PlateVision behöver en Mac

Hela din spec bygger på att varje fas avslutas med *kompilera, rätta felen,
kör, testa*. Den här datorn är Windows utan Xcode, så den loopen kan inte
köras här. Koden är skriven för att första kompileringen ska gå igenom, och
README:n innehåller dina faser 1–11 som checklista — men tills den öppnas i
Xcode är den overifierad.

En sak i din spec krockar med verkligheten: **Vision har ingen fordonsdetektor.**
Ansikten, djur, rektanglar, streckkoder och text finns — men ingen klass som
ger en ruta runt "bil". Fordonssteget kräver alltså en Core ML-modell redan
från början, inte först i fas 11.
