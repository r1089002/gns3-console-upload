# GNS3 Console Upload

Statische HTTPS-pagina voor de menuactie **Upload config** bij Cisco-switches in GNS3. Open via GNS3; los openen bevat geen bronconfig.

## Fysieke console en upload

Gebruik Chrome of Edge op de laptop met de USB-consolekabel. Sluit PuTTY en kies bij **Fysieke console** de juiste snelheid (standaard 9600 baud). Klik op **Verbinden** en selecteer de COM-poort. De verbinding opent zonder bytes te versturen. Druk zelf op **Enter** om de prompt op te vragen. Gebruik `show version` om het toestel te controleren, `enable` om van `>` naar `#` te gaan en `end` om configuratiemodus te verlaten. De terminal biedt ook spatie bij `--More--` en Ctrl+C.

Een geldige GNS3-bronconfig, de gewone IOS-`#`-prompt en een klik op **Upload naar switch** starten de overdracht. De uploader controleert de prompt opnieuw op dezelfde COM-verbinding en vergrendelt de invoer zolang hij zelf schrijft. De console toont veilige IOS-antwoorden en foutmeldingen live. Willekeurige teruggekaatste configuratieregels en geheime wachtwoordinvoer worden afgeschermd.

Bij een geslaagde overdracht of een IOS-weigering blijft de verbinding open voor handmatige controle. Wie opnieuw wil uploaden nadat `configure terminal` is aangeboden, opent een nieuwe bron via GNS3. **Verbreken** sluit de verbinding. **Upload stoppen**, een I/O-time-out of verlies van de poort sluit de verbinding en bewaakt de vrijgave.

**Opslagopdrachten uit de config filteren** staat standaard aangevinkt. Uitvinken neemt `write memory` en `copy running-config startup-config` mee als deze in de opgehaalde bron staan. De uploader voert ze na `end` uit, zodat de fysieke switch de configuratie ook voor een herstart bewaart. Andere opslagvarianten blijven gefilterd.

**L2-switch: no ip routing weglaten** verschijnt als de bron die zelfstandige IOS-opdracht bevat. Het vinkje staat bij elke nieuwe uploadpagina uit. Aanvinken verwijdert die opdracht uit het uploadvoorbeeld, de totaaltelling en de fysieke overdracht. Het opslagfilter werkt onafhankelijk.

## Palo Alto via USB-console

De GNS3-knop bij FW-NY en FW-BRU opent `palo-upload.html`. Verbind de USB-console, meld je aan, controleer het fysieke toestel en zet vooraf beoordeelde PAN-OS-`set`-opdrachten klaar vanuit een lokaal tekstbestand of het invoervak. De pagina verifieert het gekozen toestel opnieuw en controleert de candidate voordat ze de commando’s verstuurt.

De overdracht stopt bij een fout. Beoordeel de wijzigingen in de PAN-OS-candidate en voer de commit zelf uit. Het bestaande XML-bestand van de virtuele firewall is beschikbaar via Configcache. Voor USB gebruik je een afzonderlijke setlijst die voor het fysieke model is voorbereid.

## Voortgang

Ophalen toont een onbepaalde balk zolang de exporter de switch uitleest; daarna 100% wanneer de volledige config ontvangen en gevalideerd is. Er wordt geen percentage verzonnen. Upload toont het aandeel door IOS beantwoorde opdrachten, inclusief configure terminal/end. Dit is geen onafhankelijke inhoudelijke validatie van de fysieke switchconfig.

## Gegevens en hosting

Alleen statische appcode staat in deze repository. GNS3 haalt de actuele running via bestaande autorisatie op; gecontroleerde postMessage-overdracht geeft de config uitsluitend aan het geopende tabblad. Geen GNS3-token wordt doorgegeven aan de uploader. De app uploadt config niet naar GitHub en bewaart die niet in URL, localStorage of analytics. Sluiten wist de pagina-inhoud uit de actieve app; dit is geen garantie tegen browserextensies of een gecompromitteerde laptop. GitHub verwerkt gewone hostingverzoeklogs.

De GNS3-bron gebruikt nog de bestaande HTTP/LAN/VPN-route; HTTPS-hosting beveiligt die eerdere stap niet alsnog. Bescherm GitHub-schrijfrechten: wie de gepubliceerde code kan aanpassen, kan de toekomstige werking veranderen.

## Testgrens

De geactiveerde UI is met een fictieve bronconfig en een gesimuleerde switch getest via Web Serial in Chrome. Fysieke USB-seriële tests vallen buiten deze test.

## Voorbereide labconfig

GNS3 kan de pagina een voorbereide uploadconfig geven: bekende console-, enable- en gebruikerswachtwoorden zijn dan op de GNS3-server vervangen door expliciet ingestelde klare labwaarden. De pagina toont dat dit een bewerkte uploadconfig is. Onbekende wachtwoorden/hashes worden niet terugvertaald of gegokt. Het private inlog-/wachtwoordprofiel staat uitsluitend op de GNS3-server en zit niet in deze repository. De voorbereide config zelf bevat gevoelige klare tekst en moet privé blijven. De switch kan secrets na ontvangst zelf weer hashen.

## Stoppen, afsluiten en voortgang

De pagina beheert open-, schrijf- en leesbewerkingen met deadlines. Stop vraagt het afbreken van actieve I/O en het sluiten van de poort aan; er worden daarna geen nieuwe opdrachten gestart. Als een driverbewerking nog niet afgerond is, blijft de afsluiting gevolgd en toont de pagina dat de poort nog wordt vrijgegeven. Opnieuw uploaden is dan geblokkeerd. Eerder verstuurde bytes/toestelwijzigingen worden niet teruggedraaid.

Voortgang en samenvatting tellen dezelfde consoleopdrachten, inclusief configure terminal. De pagina toont het tijdstip waarop de config in dit tabblad is ontvangen en hoe lang dat geleden is; dit is geen garantie dat teamgenoten sindsdien niets aan de bron hebben gewijzigd. Geen harde vervaltijd of automatische herlaadactie toegevoegd.
