import {SERIAL_WRITES_ENABLED,SOURCE_ORIGINS} from './upload-settings.mjs?v=20261028-3';
import {describeSNMP,iosReplyPrompt,prepareRunning,receiver,sendIOS,validSNMPCredential} from './upload-core.mjs?v=20261126-1';
import {SerialSession,serialErrorMessage} from './upload-serial.mjs?v=20261126-1';
import {ConsoleTranscript,iosCompletion,iosCompletionOutput,iosHelpPage} from './upload-terminal.mjs?v=20261126-4';
import {prepareCatalyst2960} from './ios-catalyst2960.mjs?v=20261123-3';
import {prepareC8200L} from './ios-c8200l.mjs?v=20261126-2';
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
const accessSwitchNames = new Set(['S-CHI', 'S-NY', 'SW-BRU-ACC1', 'SW-BRU-ACC2']);
routingFilter.checked=false;
catalystFilter.checked=false;
c8200lFilter.checked=false;
snmpFilter.checked=false;
const consoleInput = $('console-input');
const consoleOutput = $('console-output');
const inlineConsole = $('console-screen');
const consoleScreen = inlineConsole || consoleOutput;
const consoleShortcutButtons = document.querySelectorAll('button[data-console-text]');
const personalShortcut = $('console-personal-shortcut');
const personalShortcutForm = $('console-personal-form');
const personalShortcutField = $('console-personal-text');
const personalShortcutStatus = $('console-personal-result');
const personalShortcutKey = 'gns3-console-upload.personal-shortcut';
const controlCharacters = /[\x00-\x1f\x7f]/;
let personalShortcutText = readPersonalShortcut();
const consoleStates = {
 closed: 'Verbroken', choosing: 'Poort kiezen', opening: 'Verbinden',
 open: 'Verbonden', closing: 'Poort vrijgeven', blocked: 'Poortstatus onbekend'
};
let consoleState = 'closed';
let transcript = new ConsoleTranscript({showSensitive:true});
let enteringPassword = false;
let writingManually = false;
let editorChunks = null;
let helpLinePending = false;
const commandHistory = [];
let historyIndex = 0;
let historyDraft = '';
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
 $('send').disabled=!SERIAL_WRITES_ENABLED||!serialAvailable()||!source||!uploadPlan||busy||cleanupPending||
  writingManually||helpLinePending||consoleState!=='open'||!transcript.ready||enteringPassword||(snmpFilter.checked&&!snmpReady);
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
function consoleTextWithInlinePrompt(prompt) {
 const output = transcript.text;
 const lastBreak = output.lastIndexOf('\n');
 return prompt && output.slice(lastBreak + 1).trim() === prompt
  ? output.slice(0, Math.max(0, lastBreak))
  : output;
}
function renderConsoleShortcuts() {
 for (const button of consoleShortcutButtons) {
  button.disabled = consoleInput.disabled || enteringPassword || !transcript.prompt;
 }
 if (personalShortcut) {
  personalShortcut.disabled = consoleInput.disabled || !personalShortcutText;
  const label = personalShortcutText || 'Eigen sneltekst';
  if (personalShortcut.textContent !== label) personalShortcut.textContent = label;
 }
}
function renderConsole() {
 const open = consoleState === 'open';
 const manual = open && !busy && !writingManually;
 const showInput = open && !busy && !transcript.more;
 const follow = consoleScreen.scrollHeight - consoleScreen.scrollTop - consoleScreen.clientHeight < 30;
 $('app').dataset.portState = consoleState;
 $('console-state').textContent = consoleStates[consoleState];
 $('console-mode').textContent = busy && open ? 'Upload bestuurt de console' : open ? 'Handmatige invoer' : '';
 $('console-connect').textContent = open ? 'Verbreken' : 'Verbinden';
 $('console-connect').disabled = !SERIAL_WRITES_ENABLED || !serialAvailable() || busy ||
  writingManually || (consoleState !== 'closed' && !open);
 $('baud').disabled = consoleState !== 'closed';
 enteringPassword = transcript.password || (enteringPassword && consoleInput.value !== '');
 const prompt = enteringPassword ? 'Password:' : transcript.prompt;
 $('console-form').hidden = !showInput;
 $('console-prompt').hidden = !prompt;
 $('console-prompt').textContent = prompt || '—';
 consoleInput.placeholder = enteringPassword ? 'Wachtwoord' : 'Commando of reactie';
 consoleInput.disabled = !manual || transcript.more || helpLinePending;
 $('console-enter').disabled = consoleInput.disabled;
 $('console-interrupt').disabled = !manual;
 $('console-more').hidden = !open || busy || !transcript.more;
 $('console-more').disabled = !manual;
 const output = consoleTextWithInlinePrompt(inlineConsole && showInput ? prompt : '');
 if (consoleOutput.textContent !== output) {
  consoleOutput.textContent = output;
 }
 if (follow) consoleScreen.scrollTop = consoleScreen.scrollHeight;
 renderConsoleShortcuts();
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
  const accessSwitch = !c8200lFilter.checked && accessSwitchNames.has(data.name.trim().toUpperCase());
  catalystFilter.checked = accessSwitch;
  routingFilter.checked = accessSwitch && data.noIpRoutingCount > 0;
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
 clearCommandHistory();
 renderConsole();
 const result = await owned.close();
 finishConsoleClose(owned, result, message);
 if (result.pending) void owned.closed.then(late => finishConsoleClose(owned, late, message));
}

function showPromptHint() {
 const shortcuts = '↑/↓ Geschiedenis · Tab Aanvullen · ? IOS-help';
 if (helpLinePending) showConsoleMessage('Druk op de knop Ctrl+C om de onafgewerkte IOS-invoer te wissen.');
 else if (transcript.password || enteringPassword) showConsoleMessage('Voer het wachtwoord voor de fysieke console in.');
 else if (transcript.more) showConsoleMessage('Klik op Volgende pagina of onderbreek de uitvoer.');
 else if (transcript.question) showConsoleMessage('Lees eerst de IOS-vraag in de console en geef bewust antwoord.');
 else if (transcript.prompt.endsWith('>')) showConsoleMessage('Typ enable voor de gewone #‑prompt. ' + shortcuts);
 else if (transcript.prompt && !transcript.ready) showConsoleMessage('Typ end voor de gewone #‑prompt. ' + shortcuts);
 else if (transcript.ready) showConsoleMessage(shortcuts);
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
    if (editorChunks) {
     editorChunks.push(value);
     return;
    }
    transcript.feed(value);
    if (helpLinePending && (transcript.prompt || transcript.password || /^(?:Username|Login):$/i.test(transcript.currentLine()))) {
     helpLinePending = false;
    }
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
  resetHistoryNavigation();
  renderConsole();
  return owned.sendInput(value);
 });
}

function withConsoleEditor(action) {
 return withManualConsole(async owned => {
  const terminal = transcript;
  const chunks = [];
  editorChunks = chunks;
  renderConsole();
  try {
   await action(owned, terminal);
  } catch (error) {
   if (!leaving && transcript === terminal) terminal.feed(chunks.join(''));
   throw error;
  } finally {
   editorChunks = null;
  }
 });
}

function completeManualInput() {
 const input = consoleInput.value;
 return withConsoleEditor(async (owned, terminal) => {
  const prompt = terminal.prompt;
  const completed = reply => iosCompletion(reply, prompt, input);
  // Tab completes; two redraws preserve the answer before Ctrl+E/Ctrl+U clear the device line.
  const reply = await owned.exchangeInput(`${input}\t\x12\x12\x05\x15\x12`,
   response => completed(response) !== null, {timeoutMs:4000});
  if (leaving || session !== owned || consoleState !== 'open') return;
  const value = completed(reply);
  const output = iosCompletionOutput(reply, prompt, input, value);
  if (output.trimEnd() !== prompt) terminal.feed('\n' + output);
  consoleInput.value = terminal.password ? '' : value;
 });
}

function showContextHelp(prefix) {
 const {selectionStart, selectionEnd, selectionDirection} = consoleInput;
 return withConsoleEditor(async (owned, terminal) => {
  const prompt = terminal.prompt;
  const deadline = performance.now() + 20000;
  const output = [];
  const request = prefix + '?';
  const parse = reply => iosHelpPage(reply, prompt, prefix);
  const getPage = async keys => parse(await owned.exchangeInput(keys,
   reply => parse(reply) !== null, {timeoutMs:Math.max(1, deadline - performance.now())}));
  helpLinePending = true;
  showConsoleMessage('IOS-help ophalen…');
  let page = await getPage(request);
  output.push(page.output);
  while (page.more) {
   page = await getPage(' ');
   output.push(page.output);
  }
  // The browser retains the draft. Clear the IOS edit buffer before another key can be sent.
  const renderReply = reply => iosCompletionOutput(reply, prompt, prefix, '');
  const cleared = await owned.exchangeInput('\x05\x15\x12',
   reply => iosReplyPrompt(renderReply(reply)) === prompt, {timeoutMs:4000});
  helpLinePending = false;
  if (leaving || session !== owned || consoleState !== 'open') return;
  const echo = terminal.currentLine() === prompt ? request : '\n' + prompt + request;
  terminal.feed([echo, ...output, renderReply(cleared)].filter(Boolean).join('\n'));
  if (terminal.password) consoleInput.value = '';
  else consoleInput.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
 });
}

function resetHistoryNavigation() {
 historyIndex = commandHistory.length;
 historyDraft = '';
}

function clearCommandHistory() {
 commandHistory.length = 0;
 resetHistoryNavigation();
}

function recallCommand(direction) {
 const end = commandHistory.length;
 const next = Math.max(0, Math.min(end, historyIndex + direction));
 if (next === historyIndex) return;
 if (historyIndex === end) historyDraft = consoleInput.value;
 historyIndex = next;
 consoleInput.value = commandHistory[next] ?? historyDraft;
 const cursor = consoleInput.value.length;
 consoleInput.setSelectionRange(cursor, cursor);
}

function readPersonalShortcut() {
 try {
  const value = localStorage.getItem(personalShortcutKey) ?? '';
  return controlCharacters.test(value) ? '' : value;
 } catch {
  return '';
 }
}

function fillConsoleShortcut(text) {
 if (consoleInput.disabled || !text || leaving) return;
 resetHistoryNavigation();
 consoleInput.value = text;
 consoleInput.focus();
 consoleInput.setSelectionRange(text.length, text.length);
}

for (const button of consoleShortcutButtons) {
 button.onclick = event => {
  if (event.isTrusted && !button.disabled) fillConsoleShortcut(button.dataset.consoleText);
 };
}

if (personalShortcutForm && personalShortcut) {
 personalShortcut.onclick = event => {
  if (event.isTrusted && !personalShortcut.disabled) fillConsoleShortcut(personalShortcutText);
 };
 personalShortcutForm.onsubmit = event => {
  event.preventDefault();
  if (!event.isTrusted || leaving) return;
  const value = personalShortcutField.value;
  if (controlCharacters.test(value)) {
   personalShortcutStatus.textContent = 'Gebruik één tekstregel zonder besturingstekens.';
   return;
  }
  try {
   if (value) localStorage.setItem(personalShortcutKey, value);
   else localStorage.removeItem(personalShortcutKey);
   personalShortcutStatus.textContent = value ? 'Eigen sneltekst bewaard in deze browser.' : 'Eigen sneltekst gewist.';
  } catch {
   personalShortcutStatus.textContent = value ? 'De sneltekst staat klaar voor dit venster.' : 'Eigen sneltekst gewist in dit venster.';
  }
  personalShortcutText = value;
  personalShortcutField.value = '';
  renderConsoleShortcuts();
 };
 if (personalShortcutText) personalShortcutStatus.textContent = 'Eigen sneltekst ingesteld. Bewaar een leeg veld om die te wissen.';
 window.addEventListener('storage', event => {
  if (event.key !== personalShortcutKey && event.key !== null) return;
  personalShortcutText = readPersonalShortcut();
  renderConsoleShortcuts();
 });
}

function submitManual() {
 if (consoleInput.disabled) return;
 const input = consoleInput.value;
 if (transcript.prompt && !enteringPassword && input.trim() && input !== commandHistory.at(-1)) {
  commandHistory.push(input);
  if (commandHistory.length > 50) commandHistory.shift();
 }
 void writeManual(input + '\r', input, enteringPassword);
}
$('console-form').onsubmit = event => event.preventDefault();
consoleScreen.addEventListener('click', event => {
 if (consoleInput.disabled || event.target === consoleInput || window.getSelection()?.isCollapsed === false) return;
 consoleInput.focus();
});
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
 const cli = !consoleInput.disabled && !enteringPassword && transcript.prompt &&
  !event.ctrlKey && !event.altKey && !event.metaKey;
 if (event.key === 'Enter') {
  event.preventDefault();
  submitManual();
 } else if (cli && !event.shiftKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
  event.preventDefault();
  recallCommand(event.key === 'ArrowUp' ? -1 : 1);
 } else if (cli && event.key === '?') {
  const prefix = consoleInput.value.slice(0, consoleInput.selectionStart);
  if (/[?\x00-\x1f\x7f]/.test(prefix)) return;
  event.preventDefault();
  void showContextHelp(prefix);
 } else if (cli && event.key === 'Tab' && !event.shiftKey && consoleInput.value.trim() &&
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
 resetHistoryNavigation();
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
 if (personalShortcutField) personalShortcutField.value = '';
 clearCommandHistory();
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
