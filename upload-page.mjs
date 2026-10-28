import {SERIAL_WRITES_ENABLED,SOURCE_ORIGINS} from './upload-settings.mjs?v=20261028-2';
import {receiver,sendIOS} from './upload-core.mjs?v=20261028-2';
const $=id=>document.getElementById(id);let job=null,origin=null,accept=null,source=null,port=null,reader=null,reading=null,buffer='',ended=false,busy=false,operation=null,confirmed=0;
const serialAvailable=()=>!!navigator.serial&&isSecureContext;
function status(value){$('status').textContent=value;}
function phase(value,label){$('app').dataset.phase=value;$('phase-badge').textContent=label;const step=value==='fetching'||value==='waiting'?'fetch':value==='ready'?'ready':value==='error'&&$('fetch-progress').value<100?'fetch':'upload';for(const key of ['fetch','ready','upload']){const el=$('step-'+key);el.toggleAttribute('data-active',key===step);if(key===step)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');}}
function updateSend(){ $('send').disabled=!SERIAL_WRITES_ENABLED||!serialAvailable()||!source||busy; }
function failed(message){ended=true;accept=null;clearTimeout(timeout);phase('error','Ophalen mislukt');status(message);$('fetch-progress').value=0;$('fetch-value').textContent='Mislukt';source=null;updateSend();}
const timeout=setTimeout(()=>failed('Geen bron ontvangen. Sluit dit venster en open Upload config opnieuw vanuit GNS3.'),180000);
window.addEventListener('message',e=>{
 if(ended||e.source!==opener||!SOURCE_ORIGINS.includes(e.origin)||e.data?.version!==1)return;const d=e.data;
 if(d.type==='offer'&&!job&&/^[a-f0-9]{32}$/.test(d.job)){job=d.job;origin=e.origin;accept=receiver(origin,opener,job);$('name').textContent=d.name||'Virtuele switch';opener.postMessage({type:'accept',version:1,job},origin);return;}
 if(e.origin!==origin||d.job!==job)return;
 if(d.type==='error'){failed(d.code==='node_not_running'?'De virtuele switch staat uit. Start hem eerst; er is geen oude config gebruikt.':'Ophalen mislukt ('+String(d.code).replace(/[^a-z_]/g,'').slice(0,50)+'). Open de knop opnieuw.');return;}
 if(d.type==='status'){phase('fetching','Running-config ophalen');$('fetch-progress').removeAttribute('value');$('fetch-value').textContent='Bezig';$('fetch-note').textContent='De switch wordt uitgelezen. Een percentage is pas bekend als de volledige config ontvangen is.';status(d.state==='credentials'?'Vul de tijdelijke exportgegevens in het GNS3-venster in.':'Actuele running-config wordt opgehaald…');return;}
 try{const data=accept?.(e);if(!data)return;source=data;ended=true;accept=null;clearTimeout(timeout);$('name').textContent=data.name;$('config').textContent=data.config;$('detail').textContent=`${data.bytes.toLocaleString('nl-BE')} bytes · ${data.commands.length} opdrachten · hostname ${data.hostname}`;$('fetch-progress').value=100;$('fetch-value').textContent='100%';$('fetch-note').textContent=data.prepared?'Uploadconfig gecontroleerd; bekende labwachtwoorden in klare tekst.':'Volledige running-config ontvangen en gecontroleerd.';phase('ready','Gereed voor upload');status(data.prepared?'Uploadconfig staat klaar. Bekende labwachtwoorden gaan in klare tekst mee.':'Running-config staat klaar. Kies je COM-poort wanneer je wilt uploaden.');if(data.prepared)document.querySelector('.config-details summary').firstChild.textContent='Uploadconfig bekijken ';$('browser-note').textContent=!serialAvailable()?'Gebruik Chrome of Edge op je laptop om via USB-console te uploaden.':!SERIAL_WRITES_ENABLED?'Verzenden is uitgeschakeld.':'Er wordt pas iets verstuurd nadat jij de upload start.';updateSend();}catch{failed('De opgehaalde bron is geen volledige bruikbare IOS running-config. Niets verstuurd.');}
});
for(const allowed of SOURCE_ORIGINS)opener?.postMessage({type:'ready',version:1},allowed);
if(!opener){clearTimeout(timeout);ended=true;status('Open deze pagina via Upload config bij een switch in GNS3.');}
async function release(){const p=port;port=null;try{await reader?.cancel();}catch{}try{await reading;}catch{}reader=null;reading=null;buffer='';try{await p?.close();}catch{}}
$('send').onclick=async event=>{
 if(!event.isTrusted||!SERIAL_WRITES_ENABLED||!source||busy||!serialAvailable())return;busy=true;confirmed=0;operation=new AbortController();const signal=operation.signal;let wrote=false,outcome='done',message='';updateSend();$('baud').disabled=true;$('stop').hidden=false;$('browser-note').textContent='';phase('uploading','COM-poort kiezen');status('Kies de consolepoort van jouw fysieke switch.');
 try{
  // Explicit browser chooser; never silently select a previously permitted device.
  port=await navigator.serial.requestPort();if(signal.aborted)throw Error('Afgebroken.');await port.open({baudRate:Number($('baud').value),dataBits:8,stopBits:1,parity:'none',flowControl:'none'});
  reader=port.readable.getReader();const decoder=new TextDecoder();let disconnected=false;
  reading=(async()=>{try{while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});if(buffer.length>2*1024*1024)throw Error('Consolelimiet bereikt.');}}catch{}finally{disconnected=true;reader.releaseLock();}})();
  const exchange=async command=>{
   if(signal.aborted)throw Error('Afgebroken.');if(disconnected)throw Error('Consoleverbinding verbroken.');buffer='';const writer=port.writable.getWriter();try{wrote=true;await writer.write(new TextEncoder().encode(command==='\r'?command:command.replace(/\n/g,'\r')+'\r'));}finally{writer.releaseLock();}
   const until=Date.now()+20000;let stable=null;
   while(Date.now()<until){if(signal.aborted)throw Error('Afgebroken.');if(disconnected)throw Error('Consoleverbinding verbroken.');if(/(?:^|\n)[\w.-]+(?:\([^\n]*\))?[#>]\s*$/.test(buffer.replace(/\r/g,'\n'))){if(stable===buffer)return buffer;stable=buffer;}else stable=null;await new Promise(r=>setTimeout(r,120));}
   throw Error('Geen volledig consoleantwoord; gestopt zonder herhaling.');
  };
  phase('uploading','Upload actief');status('Console controleren en configuratie overdragen…');
  const result=await sendIOS(source,exchange,{signal,onProgress:(n,total)=>{confirmed=n;const percent=Math.floor(n/total*100);$('upload-progress').value=percent;$('upload-value').textContent=percent+'%';$('upload-note').textContent=`${n} van ${total} opdrachten door de switch beantwoord.`;}});message=`Upload afgerond. ${result.count} opdrachten bevestigd. Niet opgeslagen voor herstart.`;source=null;
 }catch(e){
  if(!wrote&&e.name==='NotFoundError'){outcome='ready';message='Poortkeuze geannuleerd. Er is niets verstuurd.';}
  else{outcome=signal.aborted?'stopped':'error';message=(signal.aborted?'Upload gestopt.':e.message)+` ${confirmed} opdrachten bevestigd.`+(wrote?' Eerdere regels kunnen al actief zijn. Controleer de fysieke console voordat je opnieuw begint.':' Er is geen configuratie verstuurd.');if(wrote)source=null;}
 }finally{await release();busy=false;$('stop').hidden=true;$('baud').disabled=false;phase(outcome,outcome==='done'?'Upload voltooid':outcome==='ready'?'Gereed voor upload':outcome==='stopped'?'Gestopt':'Upload onderbroken');status(message);updateSend();if(outcome==='done'){$('upload-progress').value=100;$('upload-value').textContent='100%';}}
};
$('stop').onclick=()=>{operation?.abort();status('Stoppen… wachten tot de consoleverbinding gesloten is.');};
$('cancel').onclick=()=>{operation?.abort();source=null;$('config').textContent='';void release();window.close();};
window.addEventListener('pagehide',()=>{operation?.abort();source=null;accept=null;clearTimeout(timeout);void release();});
