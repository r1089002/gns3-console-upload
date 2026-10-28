# GNS3 Console Upload

Statische HTTPS-pagina voor de menuactie **Upload config** bij Cisco-switches in GNS3. Open via GNS3; los openen bevat geen bronconfig.

## Handmatige fysieke upload

De gebruiker heeft fysieke verzending vrijgegeven (`SERIAL_WRITES_ENABLED=true`). Een geldige actuele running-config en een expliciete klik op **Upload naar switch** zijn vereist. Daarna kiest de gebruiker de seriële poort in de browser. Geen poort wordt automatisch geopend bij laden of ontvangen van de bron. Chrome of Edge op een laptop met Web Serial vereist. Standaard 9600 baud; 115200 is instelbaar. De fysieke switch staat vooraf al aangemeld op een normale Cisco IOS # prompt. PuTTY moet de poort vrijlaten.

Geen fysieke loginwizard, automatische poortvertaling, automatische opslag voor herstart of automatische herhaling. IOS-fouten, ontbrekende prompt of verbindingsverlies stoppen de overdracht. Reeds toegepaste regels kunnen actief blijven; stoppen draait niets terug. Na een begonnen mislukte upload is opnieuw openen nodig.

## Voortgang

Ophalen toont een onbepaalde balk zolang de exporter de switch uitleest; daarna 100% wanneer de volledige config ontvangen en gevalideerd is. Er wordt geen percentage verzonnen. Upload toont het aandeel door IOS beantwoorde opdrachten, inclusief configure terminal/end. Dit is geen onafhankelijke inhoudelijke validatie van de fysieke switchconfig.

## Gegevens en hosting

Alleen statische appcode staat in deze repository. GNS3 haalt de actuele running via bestaande autorisatie op; gecontroleerde postMessage-overdracht geeft de config uitsluitend aan het geopende tabblad. Geen GNS3-token wordt doorgegeven aan de uploader. De app uploadt config niet naar GitHub en bewaart die niet in URL, localStorage of analytics. Sluiten wist de pagina-inhoud uit de actieve app; dit is geen garantie tegen browserextensies of een gecompromitteerde laptop. GitHub verwerkt gewone hostingverzoeklogs.

De GNS3-bron gebruikt nog de bestaande HTTP/LAN/VPN-route; HTTPS-hosting beveiligt die eerdere stap niet alsnog. Bescherm GitHub-schrijfrechten: wie de gepubliceerde code kan aanpassen, kan de toekomstige werking veranderen.

## Testgrens

De geactiveerde UI is met fictieve bronconfig en volledig vervangen seriële browser-API getest. De ontwikkelaar heeft bij deze vrijgave geen echte COM-poort geopend en niets naar fysieke apparatuur verstuurd. Een eerdere proef bevestigde echte GNS3-configontvangst zonder fysieke verzending. De echte fysieke upload moet de gebruiker zelf testen.

## Voorbereide labconfig

GNS3 kan de pagina een voorbereide uploadconfig geven: bekende console-, enable- en gebruikerswachtwoorden zijn dan op de GNS3-server vervangen door expliciet ingestelde klare labwaarden. De pagina toont dat dit een bewerkte uploadconfig is. Onbekende wachtwoorden/hashes worden niet terugvertaald of gegokt. Het private inlog-/wachtwoordprofiel staat uitsluitend op de GNS3-server en zit niet in deze repository. De voorbereide config zelf bevat gevoelige klare tekst en moet privé blijven. De switch kan secrets na ontvangst zelf weer hashen.
