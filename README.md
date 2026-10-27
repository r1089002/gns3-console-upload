# GNS3 Console Upload — teststand

Statische browserpagina voor de GNS3-menuactie **Upload config**. Open de pagina via de knop in GNS3; los openen bevat geen bronconfig.

**Fysiek verzenden staat uit** (`SERIAL_WRITES_ENABLED=false`). De pagina opent in deze teststand geen seriële poort. Geen configuratie wordt toegepast of opgeslagen op een toestel.

GNS3 haalt de running-config met de bestaande gebruikersautorisatie op. Alleen de bronconfig wordt via een gecontroleerde postMessage-handover tijdelijk aan dit venster gegeven. Geen GNS3-token wordt doorgegeven. Config blijft in browsergeheugen; geen opslag in GitHub, URL, localStorage, analytics of een upload-API. GitHub serveert uitsluitend deze statische appbestanden en verwerkt zijn normale hostingverzoeklogs.

De toegelaten bron-origin staat in upload-settings.mjs. De GNS3-bron blijft via de bestaande LAN/VPN-verbinding bereikbaar. De HTTPS-pagina hoeft zelf geen HTTP-exportservice te benaderen. Chrome/Edge op een laptop bieden Web Serial; deze teststand gebruikt die API nog niet.

Geen lokale server, browserextensie of certificaatinstallatie nodig om deze gehoste pagina te openen. Echte fysieke verzending en de bijbehorende hardwarecontrole zijn een afzonderlijke, expliciet vrij te geven vervolgstap. Geen fysieke loginwizard, automatische poortvertaling of automatische startup-save.
