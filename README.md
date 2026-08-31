# Trafiksimulator

Mikrosimulering av biltrafik i svenska städer, byggd för att svara på planerares
frågor: *var stannar trafiken, varför, och vad händer om vi ändrar något?*

Vägnätet kommer från OpenStreetMap och tolkas till en trafikteknisk modell —
körfält, hastighetsgränser, svängförbud, väjningsplikt, huvudleder,
cirkulationsplatser och signalreglerade korsningar. Efterfrågan byggs ur
markanvändningen med en gravitationsmodell, en dygnsprofil för svensk tätort och
en bilandel som varierar med hur tät bebyggelsen är.

Publicerad version: **https://trafiksimulator.netlify.app** (Uppsala tätort).
Fungerar på dator och telefon, i ljust och mörkt tema. Att köra lokalt behövs bara
för att hämta fler städer eller ändra i modellen.

## Kom igång

```bash
npm install
```

```bash
npm run dev
```

Uppsala tätort ligger färdigt i `public/data/`. Andra städer hämtas med
`npm run fetch <stad>` — färdiga utsnitt finns för `uppsala`, `uppsala-centrum`,
`stockholm`, `goteborg`, `malmo`, `linkoping`, `vasteras` och `orebro`.

Ett eget område hämtas med en bbox (syd, väst, nord, öst):

```bash
npm run fetch sigtuna 59.58 17.68 59.65 17.78
```

Hämtade utsnitt hamnar i `public/data/` och följer med nästa bygge. Den
publicerade versionen innehåller bara de städer som fanns när den byggdes —
övriga är gråmarkerade i stadsväljaren.

## Publicera

```bash
npm run build
```

`netlify.toml` pekar ut `dist` och sätter cachningsregler för kartdatan.
Sajten ligger på Netlify-projektet `trafiksimulator`.

## Så fungerar modellen

**Hybrid mikro/meso.** Länkarna runt det du tittar på simuleras fordon för fordon:
varje bil har egen acceleration (Intelligent Driver Model), byter fil (MOBIL med
svensk högerplacering) och söker luckor i korsningar. Resten av nätet körs som
kö-och-server per länk, med korsningsfördröjning inräknad så att resultatet inte
hoppar beroende på hur stort område som råkar simuleras i detalj. Fordonen är
desamma i båda modellerna och byter läge när de går över till en ny länk, så en
resa kan börja i meso, köra genom mikroområdet och fortsätta i meso utan att tappa
sin rutt. Det är det som gör att hela tätorten kan gå samtidigt som centrum
återges bil för bil.

**Korsningar.** Varje tillåten rörelse blir en egen bana genom korsningen.
Rörelser som korsar varandra geometriskt får en konfliktrelation, och företrädet
avgörs av huvudled före anslutande gata, högerregeln mellan likvärdiga gator,
väjningsplikt in i cirkulationsplats, och att svängande lämnar företräde åt
mötande. Två saker som OSM inte innehåller men som avgör kapaciteten läggs till:
korsningsnoder som i verkligheten är en korsning slås ihop, och huvudleden genom
varje osignalerad korsning pekas ut efter körfält, hastighet och gatans betydelse.
Utan det senare får varje korsning i innerstaden fyra tillfarter som väjer för
varandra i ring.

**Signaler.** OSM taggar `highway=traffic_signals` per tillfart, inte per
korsning. Signalerna knyts därför till den korsning de faktiskt styr och klustras
till en anläggning. Faserna genereras ur konfliktgrafen, en flerfältig tillfart får
eget vänstersvängfält med skyddad fas, och sekvensen följer svensk standard: grön →
gul → röd → röd+gul, med gultid efter tillfartshastighet och utrymningstid efter
korsningsbredd.

Anläggningarna är **trafikstyrda** som normalläge, vilket är hur svenska
tätortssignaler fungerar: detektorer i tillfarterna förlänger grönt så länge fordon
fortsätter komma, och en fas utan väntande fordon hoppas över. En fast cykel som
rullar vidare oavsett trafik växlar i onödan när det är glest och förlänger inte när
det behövs. Cykeltiderna hamnar på 45–110 sekunder beroende på antalet faser, med
minst nio sekunders grönt per fas — kortare än så hinner en stående kö aldrig komma
igång. Fast tidsstyrning går att välja per anläggning i signalpanelen.

**Filbyten** följer MOBIL: bytet vägs som vinsten i egen framkomlighet mot vad den
bakomvarande i målfilen förlorar, med en hövlighetsfaktor som avgör hur mycket
hänsyn föraren tar. Behovet av att komma i rätt fil inför korsningen växer med
närheten, så positioneringen sker i god tid i stället för som en panikmanöver vid
stopplinjen. Och när någon i grannfilen måste in släpper förarna fram — utan den
samverkan uppstår aldrig någon lucka när det är tätt, och en sammanflätning
stannar upp i stället för att vävas ihop.

**Ruttval.** Varje bil får en **planerad rutt** hela vägen till målet när den
startar, byggd ur ett kortaste-väg-träd per målzon med svängstraff, en kostnad per
passerad korsning och ett hierarkimotstånd som håller trafiken på huvudnätet. Att
rutten är planerad i förväg är avgörande: ett fordon som i stället följer ett träd
som räknas om under färden kan skickas fram och tillbaka och aldrig komma fram, och
sådana bilar samlas i nätet tills staden fylls av trafik som inte ska någonstans.

Alla kör inte snabbaste vägen. Förarna delas i fyra grupper med olika vägvana —
de flesta tar den snabbaste, en dryg tiondel kör påtagligt annorlunda — vilket är
både verklighetstroget och det som gör att trafiken fördelar sig över parallella
stråk i stället för att lägga sig i en enda linje.

Träden räknas om löpande med uppmätta restider, så köer får trafiken att söka sig
andra vägar, och en avstängd gata slår igenom inom någon minut simulerad tid. Möter
ett fordon en helt igenproppad gata svänger det av, precis som en förare gör.

**Efterfrågan** räknas ur bebyggelsen, på samma grund som trafikutredningar
använder: byggnadernas fotavtryck gånger antal våningar. Golvytan säger hur många
som bor eller arbetar någonstans på ett sätt som gatulängd aldrig kan — ett
villaområde har mycket gata per boende och ett flerbostadsområde nästan ingen, så
gatulängd lägger trafiken i precis fel ände av staden.

För målpunkter används parkeringskapaciteten vid sidan av golvytan. En handelsplats
kan omöjligt ta emot fler bilar per dag än platserna gånger omsättningen, och
omvänt fylls platserna om verksamheten drar folk. De två måtten jämförs och det
högre gäller — att lägga ihop dem vore att räkna samma resa två gånger.

Merparten av husen i OSM bär bara `building=yes`. De klassificeras ur sin
omgivning: markanvändningen på platsen, parkeringen intill, grannhusens taggning
och det egna fotavtrycket. Garage och uthus sorteras bort, och innerstadskvarter
räknas som blandade — butik i gatuplan, bostäder ovanpå.

Antalet resor per invånare, en bilandel som sjunker med bebyggelsetätheten och en
dygnsprofil ger sedan matrisen. Resor börjar och slutar dessutom på olika ställen
inom zonen: en bostadsresa startar på en lokalgata vid befolkningens tyngdpunkt,
men slutar vid det stråk som matar målpunkten — annars hamnar trafiken till en
galleria på villagatorna bredvid i stället för vid infarten till parkeringen. Avståndsmotståndet följer Tanners funktion, en
potens gånger en exponential, som till skillnad från en ren exponential behåller
svansen av långa resor — och det är den svansen som fyller lederna.

**Ledtrafiken räknas separat.** Trafiken på en infartsled styrs av vad leden bär,
inte av bebyggelsen vid kartkanten, och den skattas därför ur ledens kapacitet.
En del av den passerar staden utan att stanna. Blandas ledtrafiken in i
gravitationsmodellen försvinner den i avståndsmotståndet, och då står motorvägarna
tomma medan lokalgatorna får ta hela lasten.

## Vad du kan ändra

| Panel | Vad du kommer åt |
| --- | --- |
| Vy och lager | Färglägg efter framkomlighet, V/C, flöde, kö eller fördröjning. Spara kartbild. |
| Valt fordon | Klicka på en bil: varifrån den kommer, vart den ska, planerad väg utritad, restid och kötid. |
| Vald gata | Körfält, hastighetsgräns, avstängning. Uppmätt flöde, V/C, kö och fördröjning. |
| Trafiksignaler | Faser, grön-, gul- och rödtid, förskjutning, trafikstyrning, grön våg, Websteroptimering. |
| Trafikregler | Tidsluckor, kritiska luckor, otålighet, gultidsbeteende, blockeringsförbud, fordonsmix. |
| Efterfrågan | Resor per dygn, skalfaktor för framtidsscenarier, egna flöden, import/export av OD-matris. |
| Flaskhalsar | Rangordning efter förlorade fordonstimmar. Klicka för att zooma dit. |
| Scenariojämförelse | Spara mätpunkter före och efter en åtgärd och se skillnaden. |

**Tid och tempo:** väljaren i toppraden hoppar till morgonrusning, lunch,
eftermiddagsrusning eller natt, och nätet fylls först med den trafik som hör till
tiden så att bilden visar en pågående rusning och inte en tom stad. Pausknappen och
hastighetsreglaget är skilda åt: att pausa ändrar inte tempot, och tempot går att
ställa från realtid till 32 gånger. Mellanslag pausar och startar.

Simuleringen räknar i steg om en kvarts sekund medan skärmen ritar sextio bilder i
sekunden. Renderingen flyttar därför fram fordonen längs deras egen riktning den
bit de hunnit sedan simuleringen senast flyttade dem — utan det rycker trafiken
fram fyra gånger i sekunden i stället för att rulla. Tiden räknas från senaste
*steget*, inte från senaste bildrutan: bildrutor kommer sextio gånger i sekunden
oavsett om ett steg hunnit tas, och mäter man mot dem blir utjämningen verkningslös.

**Flygbild:** under Vy och lager går det att lägga en flygbild under vägnätet, och
att släcka vägnätet helt. Med bara flygbild och fordon syns trafiken röra sig över
den verkliga staden — gatorna finns ju redan i bilden. Fordonen får ljusa färger
över flygbild, eftersom mörka bilar försvinner i den. Bilderna kommer från Esri
World Imagery och kräver internetanslutning; källan visas i kartans hörn.

**Verksamheter på kartan:** under Vy och lager går det att tända handel, skolor,
vård, kontor och industri var för sig. Prickens storlek följer hur mycket trafik
platsen drar till sig, och zonerna heter det platsen heter — Gränbystaden,
Stenhagens köpcentrum, Carolina Rediviva — vilket gör det möjligt att se direkt om
resorna går dit man väntar sig.

Knappen längst till höger i toppraden växlar färgtema mellan **systemets
inställning, ljust och mörkt**. Valet sparas i webbläsaren. Både kartan och
panelerna byter — vägfärgerna är egna skalor per tema, eftersom en skala som är
läsbar mot svart blir blek mot vitt.

På telefon och liten surfplatta ligger panelerna i en draglåda bakom
menyknappen, nyckeltalen som en remsa längst ner som går att dra i sidled, och
kartan styrs med fingret: dra för att panorera, nyp för att zooma, tryck för att
välja en gata. Fordonstaket sänks automatiskt på små enheter.

**Grön våg:** ctrl-klicka signalerna längs ett stråk i ordning, ange
progressionshastighet och skapa vågen.

**Egna flöden:** slå på ritläget i efterfrågepanelen och klicka på start- och
målpunkt i kartan.

**OD-import:** CSV med `från,till,fordon_per_dygn` (zonnamn eller zonnummer) eller
`från_lat,från_lon,till_lat,till_lon,antal`.

## Arbetsgång för en scenariojämförelse

1. Låt simuleringen gå tills nyckeltalen slutat driva — ungefär en halvtimme
   simulerad tid från start.
2. Spara en mätpunkt.
3. Gör din ändring: stäng en gata, lägg till ett körfält, ändra en signalplan.
4. Låt den gå **lika länge** igen och spara en mätpunkt till.
5. Skillnaden i medelhastighet, restid, fördröjning och CO₂ visas mot den första
   mätpunkten.

Att köra lika länge är viktigt. Under en rusning fylls nätet på, och två mätpunkter
tagna efter olika lång tid går inte att jämföra.

## Verktyg utan webbläsare

```bash
npm run inspect uppsala
```

Bygger nätet och skriver ut vägklasser, korsningar, signalanläggningar, zoner och
sanitetskontroller.

```bash
npm run simtest uppsala 180 1600 1
```

Kör 180 simulerade minuter med 1600 m mikroområde och full efterfrågan, och
rapporterar prestanda, trafikala nyckeltal och flaskhalsar. `full` istället för
radien kör hela nätet mikroskopiskt.

```bash
npm run diagnose 120 1
```

Följer varje fastlåst fordon bakåt till det som faktiskt blockerar, och mäter
korsningarnas genomströmning. Ett fåtal fordon som står länge i en hård rusning är
normalt; blir de många är det ett modellfel och det här talar om var.

```bash
npm run calibrate 75 1
```

Jämför modellens utlagda flöden med uppmätta trafikmängder. **Fyll i din egen
mätdata i tabellen överst i skriptet** — de värden som ligger där är grova
riktvärden och duger bara till att se storleksordningen.

## Vad modellen ger för Uppsala, och hur säkra siffrorna är

Med standardinställningarna: 22 800 länkar, 65 signalanläggningar, 165 trafikzoner
och en morgonrusning som håller 25–27 km/h medelhastighet. Simuleringen går 55–65
gånger snabbare än realtid med ett 1600 m mikroområde.

Två kontroller går att göra direkt, och båda stämmer:

**Folkmängden.** Modellen räknar fram ungefär 185 000 boende ur byggnadsbeståndet.
Uppsala tätort har omkring 170 000. Nio procents fel på en siffra som aldrig matats
in är ett gott tecken på att bebyggelsetolkningen håller.

**Mättnadsflödet i korsningarna.** Uppmätt till ungefär 1 700 fordon per körfält och
grönsekundstimme vid köade signaltillfarter. Det är precis den nivå en verklig
korsning presterar, vilket betyder att kapaciteten i modellen inte är godtycklig.

En kalibreringskörning mot ungefärlig årsdygnstrafik ger en medelkvot kring 0,8 med
de flesta gator mellan 0,5 och 1,3. Det som går att lita på är alltså **var**
trafiken stannar och **hur mycket bättre eller sämre** det blir av en åtgärd.
Absoluta flödestal på en enskild gata ska kalibreras innan de används som
beslutsunderlag.

Grundefterfrågan ligger på 85 % av den skattade, därför att den skattade är något
högre än vad nätet hinner svälja i maxtimmen. Skillnaden ligger sannolikt i
signalplanerna: verklighetens signaler är samordnade och intrimmade på ett sätt en
automatiskt genererad plan inte är. Websteroptimeringen i signalpanelen är ett sätt
att ta igen en del av det.

Har kommunen egna resvaneundersökningar eller mätta flöden är det första du bör
göra att ersätta efterfrågan: sätt `Resor per dygn` i efterfrågepanelen eller
importera OD-matrisen. Kontrollera sedan med `npm run calibrate` att flödena
stämmer på de gator du har mätdata för.

## Att veta om datan

OSM är ojämnt taggat. I Uppsala har ungefär en tredjedel av gatorna explicit
`maxspeed` och en tiondel `lanes` — resten faller tillbaka på schablonvärden per
vägklass. Svängpilar (`turn:lanes`) finns på ett sextiotal sträckor. Av 29 000
byggnader bär 63 % bara `building=yes` och bara var sjunde har våningsantal, vilket
är varför klassificeringen ur omgivningen behövs. Modellen är
alltså bara så exakt som underlaget, och för en skarp utredning bör körfält och
hastigheter på de gator som utreds kontrolleras mot verkligheten. Det görs enklast
direkt i gränssnittet på den valda gatan.

## Teknik

TypeScript utan ramverk. Simuleringen kör i en Web Worker med all fordonsdata i
typade arrayer (struct-of-arrays), och renderingen sker i WebGL2 — vägnätet som ett
indexerat triangelnät som färgläggs via en datatextur, fordonen instansierat.
Fordonsbufferten skickas fram och tillbaka mellan trådarna utan kopiering.

Hot-loopen är skriven som rena funktioner över typade arrayer och går att flytta
till WASM utan att modellen skrivs om.
