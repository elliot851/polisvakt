# Blockerade punkter

## 1. Netlify har pausat utrullningar — nya versioner kan inte ut

**Vad:** rulla ut den senaste versionen (nu v29) till polisvakt.netlify.app.

**Vad som händer:** utrullningsrutan finns inte längre på deploys-sidan. Banner
högst upp:

> elliot-dcapaag's team is now running on operational credits. Your published
> sites are still live, but production deploys and Agent Runners are paused.
> The remaining balance is from operational credits that help keep your sites
> online and can't be spent on production deploys. Upgrade your team or wait
> for your next billing cycle to resume.

**Vad jag provade:**

1. Laddade om deploys-sidan två gånger — `input[type=file]` gick från 2 till 0.
   Det var alltså inte ett renderingsfel; rutan är borttagen.
2. Lyfte fram fönstret och valde fliken via UI Automation, ifall det var den
   kända bakgrundsflik-buggen. Sidan var synlig, rutan fanns ändå inte.
3. Nytt fönster, ny flik, ny inladdning. Samma sak.
4. Läste hela bannern för att skilja ett tillfälligt fel från ett kontobeslut.
   Det är ett kontobeslut.
5. Vägde alternativa vägar:
   - **Netlify CLI** — inte installerad, och skulle träffa exakt samma
     kontogräns. Ingen väg runt.
   - **Netlify Drop** — skapar en NY sajt med ny adress. Uppdaterar alltså
     inte polisvakt.netlify.app, som är adressen i din QR-kod och på din
     hemskärm.
   - **Annan värd** (Vercel, Cloudflare Pages) — kräver att jag skapar ett
     konto åt dig, vilket jag inte gör, och byter adress.

**Min bedömning:** det här går inte att lösa med en annan metod. Det är inte
en teknisk spärr utan en betalningsgräns på ditt konto, och att häva den är
ett köp. Se MANUELLT.md punkt 0. Paketet ligger som `polisvakt-KLAR-ATT-RULLA-UT.zip` i projektmappen.

**Konsekvens under tiden:** v27 ligger live och fungerar för dig. Men den
tystar rapporter från *andra* förare — se nedan. Den senaste versionen innehåller fixarna och är
byggd, testad och paketerad. Den ligger klar och väntar bara på att kunna
skickas.

**Detta är inte blockerat:** databasmigreringen `kvalitetsfalt.sql` är körd
skarpt och verifierad. Serversidan är alltså redan redo.
