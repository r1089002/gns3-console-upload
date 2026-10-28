import {SERIAL_WRITES_ENABLED,SOURCE_ORIGINS} from './upload-settings.mjs?v=20261028-3';
import {receiver,sendIOS} from './upload-core.mjs?v=20261028-3';
import {SerialSession,serialErrorMessage} from './upload-serial.mjs?v=20261028-3';
const $=id=>document.getElementById(id);let job=null,origin=null,accept=null,source=null,session=null,cleanupPending=false,ended=false,busy=false,operation=null,confirmed=0,receivedAt=null,ageTimer=null,ageMinute=-1;
const serialAvailable=()=>!!navigator.serial&&isSecureContext;
function status(value){$('status').textContent=value;}
function phase(value,label){$('app').dataset.phase=value;$('phase-badge').textContent=label;const step=value==='fetching'||value==='waiting'?'fetch':value==='ready'?'ready':value==='error'&&$('fetch-progress').value<100?'fetch':'upload';for(const key of ['fetch','ready','upload']){const el=$('step-'+key);el.toggleAttribute('data-active',key===step);if(key===step)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');}}
function updateSend(){ $('send').disabled=!SERIAL_WRITES_ENABLED||!serialAvailable()||!source||busy||cleanupPending; }
function refreshAge(){if(receivedAt===null)return;const minutes=Math.max(0,Math.floor((Date.now()-receivedAt)/60000));if(minutes!==ageMinute){ageMinute=minutes;$('source-age').textContent=minutes===0?'zojuist':`${minutes} min geleden`;}}
function failed(message){ended=true;accept=null;clearTimeout(timeout);phase('error','Ophalen mislukt');status(message);$('fetch-progress').value=0;$('fetch-value').textContent='Mislukt';source=null;updateSend();}
const timeout=setTimeout(()=>failed('Geen bron ontvangen. Sluit dit venster en open Upload config opnieuw vanuit GNS3.'),180000);
window.addEventListener('message',e=>{
 if(ended||e.source!==opener||!SOURCE_ORIGINS.includes(e.origin)||e.data?.version!==1)return;const d=e.data;
 if(d.type==='offer'&&!job&&/^[a-f0-9]{32}$/.test(d.job)){job=d.job;origin=e.origin;accept=receiver(origin,opener,job);$('name').textContent=d.name||'Virtuele switch';opener.postMessage({type:'accept',version:1,job},origin);return;}
 if(e.origin!==origin||d.job!==job)return;
 if(d.type==='error'){failed(d.code==='node_not_running'?'De virtuele switch staat uit. Start hem eerst; er is geen oude config gebruikt.':'Ophalen mislukt ('+String(d.code).replace(/[^a-z_]/g,'').slice(0,50)+'). Open de knop opnieuw.');return;}
 if(d.type==='status'){phase('fetching','Running-config ophalen');$('fetch-progress').removeAttribute('value');$('fetch-value').textContent='Bezig';$('fetch-note').textContent='De switch wordt uitgelezen. Een percentage is pas bekend als de volledige config ontvangen is.';status(d.state==='credentials'?'Vul de tijdelijke exportgegevens in het GNS3-venster in.':'Actuele running-config wordt opgehaald…');return;}
 try{const data=accept?.(e);if(!data)return;source=data;ended=true;accept=null;clearTimeout(timeout);$('name').textContent=data.name;$('config').textContent=data.config;$('detail').textContent=`${data.bytes.toLocaleString('nl-BE')} bytes · ${data.commands.length+1} consoleopdrachten · hostname ${data.hostname}`;receivedAt=Date.now();$('received-at').dateTime=new Date(receivedAt).toISOString();$('received-at').textContent=new Date(receivedAt).toLocaleTimeString('nl-BE',{hour:'2-digit',minute:'2-digit',second:'2-digit'});$('source-freshness').hidden=false;refreshAge();ageTimer=setInterval(refreshAge,30000);$('upload-note').textContent=`0 van ${data.commands.length+1} consoleopdrachten, inclusief configure terminal.`;$('fetch-progress').value=100;$('fetch-value').textContent='100%';$('fetch-note').textContent=data.prepared?'Uploadconfig gecontroleerd; bekende labwachtwoorden in klare tekst.':'Volledige running-config ontvangen en gecontroleerd.';phase('ready','Gereed voor upload');status(data.prepared?'Uploadconfig staat klaar. Bekende labwachtwoorden gaan in klare tekst mee.':'Running-config staat klaar. Kies je COM-poort wanneer je wilt uploaden.');if(data.prepared)document.querySelector('.config-details summary').firstChild.textContent='Uploadconfig bekijken ';$('browser-note').textContent=!serialAvailable()?'Gebruik Chrome of Edge op je laptop om via USB-console te uploaden.':!SERIAL_WRITES_ENABLED?'Verzenden is uitgeschakeld.':'Er wordt pas iets verstuurd nadat jij de upload start.';updateSend();}catch{failed('De opgehaalde bron is geen volledige bruikbare IOS running-config. Niets verstuurd.');}
});
for(const allowed of SOURCE_ORIGINS)opener?.postMessage({type:'ready',version:1},allowed);
if(!opener){clearTimeout(timeout);ended=true;status('Open deze pagina via Upload config bij een switch in GNS3.');}
function stopOperation(){operation?.abort();session?.stop();}
function closeNote(result){return result.complete?'':result.pending?' De COM-poort wordt nog vrijgegeven; wacht met opnieuw verbinden.':' Het sluiten van de COM-poort kon niet worden bevestigd. Controleer de kabel en sluit dit venster.';}
$('send').onclick=async event=>{
 if(!event.isTrusted||!SERIAL_WRITES_ENABLED||!source||busy||cleanupPending||!serialAvailable())return;
 busy=true;confirmed=0;operation=new AbortController();const signal=operation.signal;let owned=null,outcome='done',message='';updateSend();$('baud').disabled=true;$('stop').hidden=true;$('browser-note').textContent='';$('app').dataset.portState='choosing';phase('uploading','COM-poort kiezen');status('Kies de consolepoort van jouw fysieke switch. Annuleren kan in het browservenster.');
 try{
  const chosen=await navigator.serial.requestPort();if(signal.aborted)throw Error('Afgebroken.');owned=new SerialSession(chosen);session=owned;$('stop').hidden=false;$('app').dataset.portState='opening';phase('uploading','Console openen');status('Consoleverbinding openen…');
  await owned.open({baudRate:Number($('baud').value),dataBits:8,stopBits:1,parity:'none',flowControl:'none'});$('app').dataset.portState='open';phase('uploading','Upload actief');status('Console controleren en configuratie overdragen…');
  const result=await sendIOS(source,command=>owned.exchange(command),{signal,onProgress:(n,total)=>{confirmed=n;const percent=Math.floor(n/total*100);$('upload-progress').value=percent;$('upload-value').textContent=percent+'%';$('upload-note').textContent=`${n} van ${total} consoleopdrachten door de switch beantwoord.`;}});message=`Upload afgerond. ${result.count} consoleopdrachten bevestigd. Niet opgeslagen voor herstart.`;source=null;
 }catch(error){
  if(!signal.aborted&&!owned?.wrote&&error.name==='NotFoundError'){outcome='ready';message=serialErrorMessage(error);}
  else{outcome=signal.aborted?'stopped':'error';message=(signal.aborted?'Upload gestopt.':serialErrorMessage(error))+` ${confirmed} consoleopdrachten bevestigd.`+(owned?.wrote?' Eerdere regels kunnen al actief zijn. Controleer de fysieke console voordat je opnieuw begint.':' Er is geen configuratie verstuurd.');if(owned?.wrote)source=null;}
 }finally{
  const closed=owned?await owned.close():{complete:true};cleanupPending=!closed.complete;busy=false;$('stop').hidden=true;$('baud').disabled=cleanupPending;$('app').dataset.portState=closed.complete?'closed':closed.pending?'closing':'unknown';phase(outcome,outcome==='done'?'Upload voltooid':outcome==='ready'?'Gereed voor upload':outcome==='stopped'?'Gestopt':'Upload onderbroken');status(message+closeNote(closed));updateSend();if(outcome==='done'){$('upload-progress').value=100;$('upload-value').textContent='100%';}
  if(closed.complete){if(session===owned)session=null;}
  else owned.closed.then(late=>{if(session!==owned)return;cleanupPending=!late.complete;$('baud').disabled=cleanupPending;$('app').dataset.portState=late.complete?'closed':'unknown';status(message+closeNote(late));if(late.complete)session=null;updateSend();});
 }
};
$('stop').onclick=()=>{stopOperation();status('Stoppen… de actieve consolebewerking wordt afgebroken.');};
$('cancel').onclick=()=>{stopOperation();source=null;$('config').textContent='';clearInterval(ageTimer);void session?.close();window.close();};
window.addEventListener('pagehide',()=>{stopOperation();source=null;accept=null;clearTimeout(timeout);clearInterval(ageTimer);void session?.close();});
