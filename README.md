# GNS3 Console Upload

Statische HTTPS-pagina voor de menuactie **Upload config** bij Cisco-toestellen in GNS3. Open de pagina vanuit GNS3 om de bronconfig te ontvangen.

## Fysieke console en upload

Gebruik Chrome of Edge op de laptop met de USB-consolekabel. Sluit PuTTY en kies bij **Fysieke console** de juiste snelheid (standaard 9600 baud). Klik op **Verbinden** en selecteer de COM-poort. De verbinding opent zonder bytes te versturen. Druk zelf op **Enter** om de prompt op te vragen. Gebruik `show version` om het toestel te controleren, `enable` om van `>` naar `#` te gaan en `end` om configuratiemodus te verlaten. De terminal biedt ook spatie bij `--More--` en Ctrl+C.

Typ bij een IOS-prompt het begin van een commando en druk op **Tab**. IOS vult een unieke afkorting aan in het invoerveld. Gebruik **Enter** om het commando uit te voeren. Dit gebruikt de standaard CLI-lijnbewerking van IOS.

De Cisco-console toont de seriële uitvoer inclusief gevoelige regels en teruggestuurde commando’s. Wachtwoorden zijn zichtbaar in het invoerveld terwijl je typt. Na Enter toont het transcript wat IOS zelf terugstuurt.

Een geldige GNS3-bronconfig, de gewone IOS-`#`-prompt en een klik op **Upload naar router** of **Upload naar switch** starten de overdracht. De uploader controleert de prompt opnieuw op dezelfde COM-verbinding en vergrendelt de invoer zolang hij zelf schrijft.

Bij R-CHI1, R-NY en R-Provider staat het profiel **C8200L-1N-4T met IOS XE 17.12** standaard aan. Het vertaalt de Rack 4-poortnamen in interfaceblokken, subinterfaces, routes en OSPF-regels. Voor de overdracht controleert de pagina het model, de IOS XE-versie en de vier ingebouwde poorten.

Bij S-CHI, S-NY, SW-BRU-ACC1 en SW-BRU-ACC2 staat het profiel **Catalyst 2960** bij elke nieuwe uploadpagina standaard aan. De pagina controleert het fysieke model en de IOS-versie vóór de overdracht. Je kunt het profiel per sessie uitvinken.

Bij een geslaagde overdracht of een IOS-weigering blijft de verbinding open voor handmatige controle. Wie opnieuw wil uploaden nadat `configure terminal` is aangeboden, opent een nieuwe bron via GNS3. **Verbreken** sluit de verbinding. **Upload stoppen**, een I/O-time-out of verlies van de poort sluit de verbinding en bewaakt de vrijgave.

**Opslagopdrachten uit de config filteren** staat standaard aangevinkt. Uitvinken neemt `write memory` en `copy running-config startup-config` mee als deze in de opgehaalde bron staan. De uploader voert ze na `end` uit, zodat de fysieke switch de configuratie ook voor een herstart bewaart. Andere opslagvarianten blijven gefilterd.

Met het opslagfilter aan vervalt ook de zelfstandige globale regel `service compress-config` uit het voorbeeld en de overdracht. Met het opslagfilter uit verstuurt de uploader die regel op haar oorspronkelijke positie in de running-config.

**L2-switch: no ip routing weglaten** verschijnt als de bron die zelfstandige IOS-opdracht bevat. Bij de vier accessswitches hierboven staat het dan standaard aan. Het filter laat die opdracht weg uit het uploadvoorbeeld, de totaaltelling en de fysieke overdracht. Je kunt het vinkje per sessie aanpassen. Het opslagfilter werkt onafhankelijk.

De uploader laat de twee zelfstandige exportmarkeringen `boot-start-marker` en `boot-end-marker` weg. Het voorbeeld en de opdrachtentelling volgen de verzendlijst. Echte `boot`-opdrachten behouden hun plaats. Bij een time-out meldt de pagina welke genummerde opdracht niet is bevestigd. Alleen commandonamen uit de lijst met veilige labels worden getoond.

## SNMP-profiel voor Zabbix

Bij een Cisco-bron met de Zabbix-view, groep en beheer-ACL kun je **SNMP profiel** aanvinken. Vul de authenticatie- en encryptiesleutel van deze Zabbix-host in en controleer de regels onder **SNMP-regels bekijken**. De ingevulde sleutels zijn leesbaar in de invoervelden en het voorbeeld. De uploader gebruikt ze lokaal voor de seriële overdracht.

De uploader controleert eerst de SNMPv3-gebruiker op het fysieke toestel. Hij behoudt een passend account of maakt de ontbrekende gebruiker na de gewone configuratie aan. Het fysieke toestel behoudt zijn eigen Engine ID. De gebruiker wordt vóór eventuele opslag opnieuw via de console gecontroleerd. Controleer de werkelijke uitlezing daarna in Zabbix.

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
