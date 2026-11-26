import {SERIAL_WRITES_ENABLED,SOURCE_ORIGINS} from './upload-settings.mjs?v=20261028-3';
import {describeSNMP,iosReplyPrompt,prepareRunning,receiver,sendIOS,validSNMPCredential} from './upload-core.mjs?v=20261126-1';
import {SerialSession,serialErrorMessage} from './upload-serial.mjs?v=20261126-1';
import {ConsoleTranscript,iosCompletion} from './upload-terminal.mjs?v=20261126-1';
import {prepareCatalyst2960} from './ios-catalyst2960.mjs?v=20261123-3';
import {prepareC8200L} from './ios-c8200l.mjs?v=20261126-1';
const $=id=>document.getElementById(id);let job=null,origin=null,accept=null,source=null,session=null,cleanupPending=false,ended=false,busy=false,operation=null,confirmed=0,receivedAt=null,ageTimer=null,ageMinute=-1;
const saveFilter=$('hide-save-commands');
const routingFilter=$('filter-no-ip-routing');
const catalystFilter=$('catalyst2960-profile');
const c8200lFilter=$('c8200l-profile');
let uploadPlan=null;
const snmpFilter=$('snmp-profile');
const snmpAuth=$('snmp-auth');
const snmpPriv=$('snmp-priv');
let snmpDescription=null;
const routerName = /^R-/i;
routingFilter.checked=false;
catalystFilter.checked=false;
c8200lFilter.checked=false;
snmpFilter.checked=false;
const consoleInput = $('console-input');
const consoleOutput = $('console-output');
const consoleStates = {
 closed: 'Verbroken', choosing: 'Poort kiezen', opening: 'Verbinden',
 open: 'Verbonden', closing: 'Poort vrijgeven', blocked: 'Poortstatus onbekend'
};
let consoleState = 'closed';
let transcript = new ConsoleTranscript({showSensitive:true});
let enteringPassword = false;
let writingManually = false;
let leaving = false;
const serialAvailable=()=>!!navigator.serial&&isSecureContext;
function status(value){$('status').textContent=value;}
function setSourceName(name) {
 $('name').textContent = name;
 const device = routerName.test(name.trim()) ? 'router' : /^(?:S|SW)-/i.test(name) ? 'switch' : 'toestel';
 const destination = device === 'toestel' ? 'fysiek toestel' : 'fysieke ' + device;
 $('send-label').textContent = 'Upload naar ' + device;
 $('upload-destination').textContent = 'Upload naar ' + destination;
}
function isRouterSource() {
 return [source?.name, source?.hostname].some(name => name && routerName.test(name.trim()));
}
function phase(value,label){$('app').dataset.phase=value;$('phase-badge').textContent=label;const step=value==='fetching'||value==='waiting'?'fetch':value==='ready'?'ready':value==='error'&&$('fetch-progress').value<100?'fetch':'upload';for(const key of ['fetch','ready','upload']){const el=$('step-'+key);el.toggleAttribute('data-active',key===step);if(key===step)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');}}
function updateSend(){
 const authReady=validSNMPCredential(snmpAuth.value);
 const privReady=validSNMPCredential(snmpPriv.value);
 const snmpReady=snmpDescription&&authReady&&privReady;
 $('send').disabled=!SERIAL_WRITES_ENABLED||!serialAvailable()||!source||!uploadPlan||busy||cleanupPending||writingManually||consoleState!=='open'||!transcript.ready||enteringPassword||(snmpFilter.checked&&!snmpReady);
 saveFilter.disabled=busy||cleanupPending;
 routingFilter.disabled=busy||cleanupPending;
 catalystFilter.disabled=c8200lFilter.disabled=busy||cleanupPending;
 snmpFilter.disabled=!snmpDescription||busy||cleanupPending;
 snmpAuth.disabled=snmpPriv.disabled=snmpFilter.disabled||!snmpFilter.checked;
 snmpAuth.setAttribute('aria-invalid',String(Boolean(snmpAuth.value&&!authReady)));
 snmpPriv.setAttribute('aria-invalid',String(Boolean(snmpPriv.value&&!privReady)));
}
function showConsoleMessage(message) {
 $('console-message').textContent = message;
}
function renderConsole() {
 const open = consoleState === 'open';
 const manual = open && !busy && !writingManually;
 $('app').dataset.portState = consoleState;
 $('console-state').textContent = consoleStates[consoleState];
 $('console-mode').textContent = busy && open ? 'Upload bestuurt de console' : open ? 'Handmatige invoer' : '';
 $('console-connect').textContent = open ? 'Verbreken' : 'Verbinden';
 $('console-connect').disabled = !SERIAL_WRITES_ENABLED || !serialAvailable() || busy ||
  writingManually || (consoleState !== 'closed' && !open);
 $('baud').disabled = consoleState !== 'closed';
 enteringPassword = transcript.password || (enteringPassword && consoleInput.value !== '');
 $('console-prompt').textContent = enteringPassword ? 'Password:' : transcript.prompt || '—';
 consoleInput.placeholder = enteringPassword ? 'Wachtwoord' : 'Commando of reactie';
 consoleInput.disabled = !manual || transcript.more;
 $('console-enter').disabled = consoleInput.disabled;
 $('console-interrupt').disabled = !manual;
 $('console-more').hidden = !open || busy || !transcript.more;
 $('console-more').disabled = !manual;
 const output = transcript.text;
 if (consoleOutput.textContent !== output) {
  const follow = consoleOutput.scrollHeight - consoleOutput.scrollTop - consoleOutput.clientHeight < 30;
  consoleOutput.textContent = output;
  if (follow) consoleOutput.scrollTop = consoleOutput.scrollHeight;
 }
 updateSend();
}
function selectedUpload(){
 const excludeNoIpRouting=Boolean(routingFilter.checked&&source.noIpRoutingCount);
 const excludeVirtualSNMPEngineId=Boolean(snmpFilter.checked&&snmpDescription?.excludesEngineId);
 if(c8200lFilter.checked){
  const router=prepareC8200L(source.rawConfig);
  return {
   ...prepareRunning(router.config,{excludeNoIpRouting,excludeVirtualSNMPEngineId,excludeVersionHeader:true}),
   c8200lChanges:router.changes,
  };
 }
 if(catalystFilter.checked){
  const catalyst=prepareCatalyst2960(source.rawConfig);
  return {...prepareRunning(catalyst.config,{excludeNoIpRouting,excludeVirtualSNMPEngineId}),catalystChanges:catalyst.changes};
 }
 return excludeNoIpRouting||excludeVirtualSNMPEngineId
  ?prepareRunning(source.rawConfig,{excludeNoIpRouting,excludeVirtualSNMPEngineId}) :source;
}
function renderSNMPPreview() {
 const preview = snmpDescription && describeSNMP(source, {
  auth: snmpAuth.value || '<authenticatiesleutel>',
  priv: snmpPriv.value || '<encryptiesleutel>',
 });
 $('snmp-preview').textContent = preview?.lines.join('\n') || '';
}
function clearSNMPCredentials() {
 snmpAuth.value = '';
 snmpPriv.value = '';
 renderSNMPPreview();
}
function renderSNMP(){
 snmpDescription=source?describeSNMP(source):null;
 $('snmp-control').hidden=!source;
 $('snmp-details').hidden=!snmpDescription;
 if(!snmpDescription){
  snmpFilter.checked=false;
  $('snmp-details').open=false;
  clearSNMPCredentials();
 }
 $('snmp-credentials').hidden=!snmpFilter.checked;
 renderSNMPPreview();
 const note=$('snmp-note');
 if(!snmpDescription) note.textContent='Voor deze bron is geen compleet SNMPv3-profiel beschikbaar.';
 else if(snmpFilter.checked) note.textContent='Vul de twee SNMPv3-sleutels voor dit toestel in. Gebruik per sleutel 8 tot 64 tekens met letters, cijfers, !, _ of -.'
  +(snmpDescription.excludesEngineId?' Het fysieke Cisco-toestel behoudt zijn eigen SNMP Engine ID.':'');
 else note.textContent='Vink aan om de Zabbix-gebruiker mee te sturen.';
}
function renderUploadConfig(){
 uploadPlan=null;
 const router = isRouterSource();
 $('save-control').hidden=!source;
 $('routing-control').hidden=!source?.noIpRoutingCount;
 $('catalyst2960-control').hidden=!source||router;
 $('c8200l-control').hidden=!router;
 renderSNMP();
 if(!source){
  $('config').textContent='';
  $('config-details').open=false;
  return;
 }
 const routerNote=$('c8200l-note');
 routerNote.textContent='Het Rack 4-profiel vertaalt Gi0/0 t/m Gi0/3 naar Gi0/0/0 t/m Gi0/0/3. Het toestelmodel en de IOS XE-versie worden vóór de upload gecontroleerd.';
 try {
  uploadPlan=selectedUpload();
 } catch(error) {
  if(!c8200lFilter.checked)throw error;
  routerNote.textContent=error.message;
  $('config').textContent='';
  $('config-details').open=false;
  $('detail').textContent='Geen verzendlijst voor dit routerprofiel.';
  $('upload-note').textContent='Kies een bruikbare config voor dit profiel.';
  updateSend();
  return;
 }
 const plan=uploadPlan;
 if(plan.c8200lChanges){
  routerNote.textContent+=' Actieve bronpoorten krijgen no shutdown. Controleer de verzendlijst voor de upload.';
 }
 const filtered=plan.excludedSaveCommands.length;
 const included=saveFilter.checked?0:plan.saveCommands.length;
 const config=saveFilter.checked?plan.config:plan.configWithSaves;
 const commands=saveFilter.checked?plan.commands:plan.commandsWithSaves;
 const changes=plan.catalystChanges;
 $('catalyst2960-note').textContent=changes
  ? `${Object.values(changes).reduce((sum,value)=>sum+value,0)} aanpassingen. Bekijk hieronder de verzendlijst. SSH-algoritmes en het eigen certificaat volgen de mogelijkheden van de fysieke switch.`
  : 'Zet dit aan voor de fysieke WS-C2960-24TT-L of WS-C2960-24TC-L met IOS 15.0(2)SE. Het model wordt vóór de upload gecontroleerd.';
 const total=commands.length+included+1+(snmpFilter.checked?snmpDescription.operationCount:0);
 $('config').textContent=config;
 $('detail').textContent=`${new TextEncoder().encode(config).byteLength.toLocaleString('nl-BE')} bytes · ${total} consoleopdrachten · hostname ${source.hostname}`;
 if(!$('upload-progress').value)$('upload-note').textContent=`0 van ${total} consoleopdrachten, inclusief configure terminal.`;
 const saveNote=included
  ?`${included} ${included===1?'opslagopdracht wordt':'opslagopdrachten worden'} na de running-config uitgevoerd.`
  :filtered
   ?`${filtered} ${filtered===1?'opslagopdracht uit de config gefilterd.':'opslagopdrachten uit de config gefilterd.'}`
   :'Geen opslagopdrachten gevonden in deze running-config.';
 $('save-upload-note').textContent=saveFilter.checked&&plan.excludedStorageSettings
  ?`${saveNote} service compress-config wordt overgeslagen.` :saveNote;
 $('destination-save-title').textContent=included?'Ook opslaan voor herstart':'Alleen de running-config';
 $('destination-save-note').textContent=included
  ?'De opslagopdrachten schrijven de actieve configuratie naar de startup-config van het fysieke toestel.'
  :'De upload past de regels toe in het werkgeheugen van het toestel.';
 const routingCount=source.noIpRoutingCount;
 $('routing-upload-note').textContent=routingFilter.checked&&routingCount
  ?routingCount===1
   ?'Deze regel wordt overgeslagen in de fysieke upload.'
   :routingCount+' regels worden overgeslagen in de fysieke upload.'
  :'Vink aan als je fysieke Layer 2-switch deze IOS-opdracht weigert.';
 updateSend();
}
function refreshAge(){if(receivedAt===null)return;const minutes=Math.max(0,Math.floor((Date.now()-receivedAt)/60000));if(minutes!==ageMinute){ageMinute=minutes;$('source-age').textContent=minutes===0?'zojuist':`${minutes} min geleden`;}}
function failed(message){ended=true;accept=null;clearTimeout(timeout);phase('error','Ophalen mislukt');status(message);$('fetch-progress').value=0;$('fetch-value').textContent='Mislukt';source=null;renderUploadConfig();updateSend();}
const timeout=setTimeout(()=>failed('Geen bron ontvangen. Sluit dit venster en open Upload config opnieuw vanuit GNS3.'),180000);
window.addEventListener('message',e=>{
 if(ended||e.source!==opener||!SOURCE_ORIGINS.includes(e.origin)||e.data?.version!==1)return;const d=e.data;
 if(d.type==='offer'&&!job&&/^[a-f0-9]{32}$/.test(d.job)){job=d.job;origin=e.origin;accept=receiver(origin,opener,job);setSourceName(typeof d.name === 'string' && d.name ? d.name : 'Virtueel toestel');opener.postMessage({type:'accept',version:1,job},origin);return;}
 if(e.origin!==origin||d.job!==job)return;
 if(d.type==='error'){failed(d.code==='node_not_running'?'Het virtuele toestel staat uit. Start hem eerst; er is geen oude config gebruikt.':'Ophalen mislukt ('+String(d.code).replace(/[^a-z_]/g,'').slice(0,50)+'). Open de knop opnieuw.');return;}
 if(d.type==='status'){phase('fetching','Running-config ophalen');$('fetch-progress').removeAttribute('value');$('fetch-value').textContent='Bezig';$('fetch-note').textContent='Het toestel wordt uitgelezen. Een percentage is pas bekend als de volledige config ontvangen is.';status(d.state==='credentials'?'Vul de tijdelijke exportgegevens in het GNS3-venster in.':'Actuele running-config wordt opgehaald…');return;}
 try {
  const data = accept?.(e);
  if (!data) return;
  source = data;
  c8200lFilter.checked = isRouterSource();
  ended = true;
  accept = null;
  clearTimeout(timeout);
  setSourceName(data.name);
  renderUploadConfig();
  receivedAt = Date.now();
  $('received-at').dateTime = new Date(receivedAt).toISOString();
  $('received-at').textContent = new Date(receivedAt).toLocaleTimeString('nl-BE', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  $('source-freshness').hidden = false;
  refreshAge();
  ageTimer = setInterval(refreshAge, 30000);
  $('fetch-progress').value = 100;
  $('fetch-value').textContent = '100%';
  $('fetch-note').textContent = data.prepared
   ? 'Uploadconfig gecontroleerd. Bekende labwachtwoorden staan in klare tekst.' : 'Volledige running-config ontvangen en gecontroleerd.';
  phase('ready','Gereed voor upload');
  status(data.prepared ? 'Uploadconfig staat klaar. Bekende labwachtwoorden gaan in klare tekst mee.'
   : 'Running-config staat klaar. Verbinden en klaarzetten doe je in de fysieke console.');
  if (data.prepared) $('config-details').querySelector('summary').firstChild.textContent = 'Uploadconfig bekijken ';
  $('browser-note').textContent = !serialAvailable() ? 'Gebruik Chrome of Edge op je laptop om via USB-console te uploaden.'
   : !SERIAL_WRITES_ENABLED ? 'Verzenden is uitgeschakeld.' : 'De configuratie wordt pas verstuurd nadat jij de upload start.';
  updateSend();
 } catch {
  failed('De opgehaalde bron is geen volledige bruikbare IOS running-config. Niets verstuurd.');
 }
});
for(const allowed of SOURCE_ORIGINS)opener?.postMessage({type:'ready',version:1},allowed);
if(!opener){clearTimeout(timeout);ended=true;status('Open deze pagina via Upload config bij een toestel in GNS3.');}
function finishConsoleClose(owned, result, message) {
 if (session !== owned) return;
 cleanupPending = !result.complete;
 consoleState = result.complete ? 'closed' : result.pending ? 'closing' : 'blocked';
 if (result.complete) session = null;
 const explanation = result.complete ? '' : result.pending
  ? ' De COM-poort wordt nog vrijgegeven.'
  : ' Het sluiten van de COM-poort kon niet worden bevestigd. Controleer de kabel en sluit dit venster.';
 showConsoleMessage(message + explanation);
 renderConsole();
}

async function closeConsole(owned, message) {
 if (session !== owned || consoleState === 'closing' || consoleState === 'blocked') return;
 consoleState = 'closing';
 cleanupPending = true;
 consoleInput.value = '';
 renderConsole();
 const result = await owned.close();
 finishConsoleClose(owned, result, message);
 if (result.pending) void owned.closed.then(late => finishConsoleClose(owned, late, message));
}

function showPromptHint() {
 if (transcript.password || enteringPassword) showConsoleMessage('Voer het wachtwoord voor de fysieke console in.');
 else if (transcript.more) showConsoleMessage('Klik op Volgende pagina of onderbreek de uitvoer.');
 else if (transcript.question) showConsoleMessage('Lees eerst de IOS-vraag in de console en geef bewust antwoord.');
 else if (transcript.prompt.endsWith('>')) showConsoleMessage('Typ enable voor de gewone #‑prompt. Tab vult commando’s aan.');
 else if (transcript.prompt && !transcript.ready) showConsoleMessage('Typ end voor de gewone #‑prompt. Tab vult commando’s aan.');
 else if (transcript.ready) showConsoleMessage('De fysieke console staat op de gewone #‑prompt. Tab vult commando’s aan.');
 else showConsoleMessage('Druk op Enter om de prompt op te vragen.');
}

$('console-connect').onclick = async event => {
 if (!event.isTrusted || !SERIAL_WRITES_ENABLED || !serialAvailable() || busy || writingManually || leaving) return;
 if (consoleState === 'open') {
  await closeConsole(session, 'Consoleverbinding verbroken.');
  return;
 }
 if (consoleState !== 'closed') return;

 const baudRate = Number($('baud').value);
 consoleState = 'choosing';
 showConsoleMessage('Kies de USB-consolepoort van je fysieke toestel.');
 renderConsole();
 let owned;
 try {
  const port = await navigator.serial.requestPort();
  if (leaving) return;
  transcript = new ConsoleTranscript({showSensitive:true});
  consoleInput.value = '';
  owned = new SerialSession(port, {
   onData(value) {
    if (session !== owned || leaving || !['opening', 'open'].includes(consoleState)) return;
    transcript.feed(value);
    if (consoleState === 'open' && !busy) showPromptHint();
    renderConsole();
   },
   onDisconnect(error) {
    if (session !== owned || leaving) return;
    void closeConsole(owned, serialErrorMessage(error));
   }
  });
  session = owned;
  consoleState = 'opening';
  showConsoleMessage('USB-console openen…');
  renderConsole();
  await owned.open({baudRate, dataBits:8, stopBits:1, parity:'none', flowControl:'none'});
  if (session !== owned || consoleState !== 'opening' || leaving) return;
  consoleState = 'open';
  showPromptHint();
  renderConsole();
  consoleInput.focus();
 } catch (error) {
  if (leaving) return;
  const message = serialErrorMessage(error);
  if (owned) await closeConsole(owned, message);
  else {
   consoleState = 'closed';
   showConsoleMessage(message);
   renderConsole();
  }
 }
};

async function withManualConsole(action) {
 if (consoleState !== 'open' || busy || writingManually || leaving || !session) return;
 const owned = session;
 writingManually = true;
 try {
  await action(owned);
 } catch (error) {
  if (consoleState === 'open') await closeConsole(owned, serialErrorMessage(error));
 } finally {
  writingManually = false;
  if (session === owned && consoleState === 'open') {
   if (transcript.prompt || transcript.password || transcript.more || transcript.question) showPromptHint();
   else showConsoleMessage('Wachten op antwoord van de fysieke console.');
  }
  renderConsole();
  if (!consoleInput.disabled) consoleInput.focus();
 }
}

function writeManual(value, input = '', password = false) {
 return withManualConsole(owned => {
  transcript.beginInput(input, {password});
  consoleInput.value = '';
  renderConsole();
  return owned.sendInput(value);
 });
}

function completeManualInput() {
 const input = consoleInput.value;
 const prompt = transcript.prompt;
 return withManualConsole(async owned => {
  transcript.beginInput();
  renderConsole();
  const completed = reply => iosCompletion(reply, prompt, input);
  // Tab completes; two redraws preserve the answer before Ctrl+E/Ctrl+U clear the device line.
  const reply = await owned.exchangeInput(`${input}\t\x12\x12\x05\x15\x12`,
   response => completed(response) !== null, {timeoutMs:4000});
  if (leaving || session !== owned || consoleState !== 'open') return;
  consoleInput.value = completed(reply);
 });
}

function submitManual() {
 if (consoleInput.disabled) return;
 const input = consoleInput.value;
 void writeManual(input + '\r', input, enteringPassword);
}
$('console-form').onsubmit = event => event.preventDefault();
$('console-enter').onclick = event => {
 if (event.isTrusted) submitManual();
};
$('console-more').onclick = event => {
 if (event.isTrusted && transcript.more) void writeManual(' ');
};
$('console-interrupt').onclick = event => {
 if (event.isTrusted) void writeManual('\x03');
};
consoleInput.onkeydown = event => {
 if (!event.isTrusted || event.isComposing) return;
 if (event.key === 'Enter') {
  event.preventDefault();
  submitManual();
 } else if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey &&
  !consoleInput.disabled && !enteringPassword && transcript.prompt && consoleInput.value.trim() &&
  !/[?\x00-\x1f\x7f]/.test(consoleInput.value)) {
  event.preventDefault();
  void completeManualInput();
 } else if (event.ctrlKey && !event.altKey && !event.metaKey &&
  event.key.toLowerCase() === 'c' && consoleInput.selectionStart === consoleInput.selectionEnd) {
  event.preventDefault();
  void writeManual('\x03');
 }
};

async function verifyC8200L(exchange) {
 const identity=(await exchange('show version | include Cisco IOS XE Software| C8200')).replace(/\r/g,'\n');
 const model=/^[ \t]*cisco[ \t]+C8200L-1N-4T[ \t]+(?:\([^\n)]*\)[ \t]+)?processor\b/im;
 const version=/^[ \t]*Cisco IOS XE Software,[ \t]+Version 17\.12(?:\.\d+[a-z]?)?[ \t]*$/im;
 if(!model.test(identity)||!version.test(identity)){
  throw Error('Dit profiel vereist een C8200L-1N-4T met IOS XE 17.12.');
 }
 const ports=await exchange('show ip interface brief | include ^GigabitEthernet0/0/');
 const onboard=new Set(Array.from(ports.matchAll(/(?:^|[\r\n])GigabitEthernet0\/0\/([0-3])[ \t]+/gi),match=>match[1]));
 if(onboard.size!==4){
  throw Error('De vier ingebouwde poorten Gi0/0/0 tot Gi0/0/3 konden niet worden bevestigd.');
 }
}

$('send').onclick = async event => {
 if (!event.isTrusted || $('send').disabled || !session || !source || leaving) return;
 const owned = session;
 const signal = (operation = new AbortController()).signal;
 const includeSaveCommands = !saveFilter.checked;
 const snmpProfile = snmpFilter.checked ? { auth: snmpAuth.value, priv: snmpPriv.value } : undefined;
 clearSNMPCredentials();
 busy = true;
 confirmed = 0;
 let outcome = 'done';
 let message;
 let configurationStarted = false;
 consoleInput.value = '';
 transcript.beginUpload(source.hostname);
 $('upload-progress').value = 0;
 $('upload-value').textContent = '0%';
 $('stop').hidden = false;
 phase('uploading', 'Upload actief');
 status('Console controleren en configuratie overdragen…');
 showConsoleMessage('Je kunt de antwoorden volgen. Handmatige invoer komt na de upload terug.');
 renderConsole();

 try {
  const exchange = (command, options) => {
   if (command === 'configure terminal') configurationStarted = true;
   return owned.exchange(command, {
    acceptAdditionalPrompt: reply => Boolean(iosReplyPrompt(reply)) || options?.acceptAdditionalPrompt?.(reply)
   });
  };
  const plan = uploadPlan;
  if(plan.c8200lChanges){
   await verifyC8200L(exchange);
  }
  if(plan.catalystChanges){
   const identity = await exchange('show version | include Model number|Cisco IOS Software');
   if(!/^[ \t]*Model number[ \t]*:[ \t]*WS-C2960-24(?:TT|TC)-L[ \t]*$/mi.test(identity.replace(/\r/g,'\n'))||!/\bVersion 15\.0\(2\)SE\d*\b/i.test(identity)){
    throw Error('Dit profiel vereist IOS 15.0(2)SE op een WS-C2960-24TT-L of WS-C2960-24TC-L.');
   }
  }
  const result = await sendIOS(plan, exchange, {
   signal, includeSaveCommands, snmpProfile,
   onProgress(n, total) {
    confirmed = n;
    const percent = Math.floor(n / total * 100);
    $('upload-progress').value = percent;
    $('upload-value').textContent = percent + '%';
    $('upload-note').textContent = n + ' van ' + total + ' consoleopdrachten door het toestel beantwoord.';
   }
  });
  message = 'Upload afgerond. ' + result.count + ' consoleopdrachten bevestigd. '
   + (result.saved ? 'Opgeslagen als startup-config.' : 'Niet opgeslagen voor herstart.');
  if (result.snmpProfile === 'existing') message += ' Bestaande SNMP-gebruiker behouden. Controleer de uitlezing in Zabbix.';
  if (result.snmpProfile === 'configured') message += ' SNMP-gebruiker aangemaakt. Controleer de uitlezing in Zabbix.';
  source = null;
 } catch (error) {
  outcome = signal.aborted ? 'stopped' : 'error';
  message = (signal.aborted ? 'Upload gestopt.' : serialErrorMessage(error))
   + ' ' + confirmed + ' consoleopdrachten bevestigd.'
   + (configurationStarted ? ' Eerdere regels kunnen al actief zijn. Controleer de fysieke console voordat je opnieuw begint.' : ' Er is geen configuratie verstuurd.');
  if (configurationStarted) source = null;
 } finally {
  transcript.endUpload();
  busy = false;
  operation = null;
  $('stop').hidden = true;
  if (!leaving) {
   phase(outcome, outcome === 'done' ? 'Upload voltooid' : outcome === 'stopped' ? 'Gestopt' : 'Upload onderbroken');
   status(message);
   if (consoleState === 'open') showPromptHint();
   renderUploadConfig();
   renderConsole();
   if (!consoleInput.disabled) consoleInput.focus();
  }
 }
};

$('stop').onclick = event => {
 if (!event.isTrusted || !busy || !session) return;
 operation?.abort();
 session.stop();
 status('Stoppen… de actieve consolebewerking wordt afgebroken.');
 void closeConsole(session, 'Upload gestopt. De consoleverbinding is verbroken.');
};

function leavePage() {
 leaving = true;
 operation?.abort();
 session?.stop();
 source = null;
 transcript = new ConsoleTranscript({showSensitive:true});
 accept = null;
 consoleInput.value = '';
 consoleOutput.textContent = '';
 $('config').textContent = '';
 clearSNMPCredentials();
 snmpFilter.checked=false;
 renderSNMP();
 clearTimeout(timeout);
 clearInterval(ageTimer);
}

saveFilter.onchange = renderUploadConfig;
routingFilter.onchange = renderUploadConfig;
catalystFilter.onchange = renderUploadConfig;
c8200lFilter.onchange = renderUploadConfig;
snmpFilter.onchange = () => {
 if(!snmpFilter.checked)clearSNMPCredentials();
 renderUploadConfig();
 updateSend();
};
snmpAuth.oninput = snmpPriv.oninput = () => {
 renderSNMPPreview();
 updateSend();
};
$('cancel').onclick = () => {
 leavePage();
 window.close();
};
window.addEventListener('pagehide', leavePage);
renderConsole();
