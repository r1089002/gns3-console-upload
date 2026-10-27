import {SERIAL_WRITES_ENABLED,SOURCE_ORIGINS} from './upload-settings.mjs';
import {receiver,sendIOS} from './upload-core.mjs';
const $=id=>document.getElementById(id);let job=null,origin=null,accept=null,source=null,port=null,reader=null,reading=null,buffer='',ended=false,busy=false;
const controller=new AbortController();
function status(value){$('status').textContent=value;}
const timeout=setTimeout(()=>{ended=true;accept=null;status('Geen bron ontvangen. Open Upload config vanuit GNS3.');},180000);
window.addEventListener('message',e=>{
 if(ended||e.source!==opener||!SOURCE_ORIGINS.includes(e.origin)||e.data?.version!==1)return;
 const d=e.data;
 if(d.type==='offer'&&!job&&/^[a-f0-9]{32}$/.test(d.job)){
  job=d.job;origin=e.origin;accept=receiver(origin,opener,job);$('name').textContent=d.name||'Virtuele switch';opener.postMessage({type:'accept',version:1,job},origin);return;
 }
 if(e.origin!==origin||d.job!==job)return;
 if(d.type==='error'){clearTimeout(timeout);ended=true;status(d.code==='node_not_running'?'De virtuele switch staat uit. Start hem eerst; er is geen oude config gebruikt.':'Ophalen mislukt ('+String(d.code).replace(/[^a-z_]/g,'').slice(0,50)+'). Open de knop opnieuw.');return;}
 if(d.type==='status'){status(d.state==='credentials'?'Wacht op de tijdelijke exportgegevens in GNS3…':'Actuele running-config wordt opgehaald…');return;}
 try{const data=accept?.(e);if(!data)return;source=data;clearTimeout(timeout);ended=true;accept=null;$('name').textContent=data.name;$('config').textContent=data.config;$('detail').textContent=`${data.bytes} bytes · ${data.commands.length} opdrachten · hostname ${data.hostname}`;status(SERIAL_WRITES_ENABLED?'Running-config klaar. Upload naar de reeds aangemelde fysieke switch.':'Running-config staat klaar. Fysiek verzenden is voor deze proef geblokkeerd; er wordt geen COM-poort geopend.');$('send').disabled=!SERIAL_WRITES_ENABLED;}catch{ended=true;clearTimeout(timeout);status('De opgehaalde bron is geen volledige bruikbare IOS running-config. Niets verstuurd.');}
});
for(const allowed of SOURCE_ORIGINS)opener?.postMessage({type:'ready',version:1},allowed);
if(!opener){clearTimeout(timeout);ended=true;status('Open deze pagina via Upload config in GNS3.');}
async function release(){const p=port;port=null;try{await reader?.cancel();}catch{}try{await reading;}catch{}try{await p?.close();}catch{}reader=null;reading=null;buffer='';}
$('send').onclick=async()=>{
 // Hard test gate precedes EVERY Serial API access, even programmatic clicks.
 if(!SERIAL_WRITES_ENABLED||!source||busy)return;busy=true;$('send').disabled=true;
 try{
  const known=await navigator.serial.getPorts();port=known.length===1?known[0]:await navigator.serial.requestPort();await port.open({baudRate:9600,dataBits:8,stopBits:1,parity:'none',flowControl:'none'});
  reader=port.readable.getReader();const decoder=new TextDecoder();let disconnected=false;
  reading=(async()=>{try{while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});if(buffer.length>2*1024*1024)throw Error('consolelimiet');}}finally{disconnected=true;reader.releaseLock();}})();
  const exchange=async command=>{
   if(controller.signal.aborted)throw Error('Afgebroken.');buffer='';const writer=port.writable.getWriter();try{await writer.write(new TextEncoder().encode(command==='\r'?command:command.replace(/\n/g,'\r')+'\r'));}finally{writer.releaseLock();}
   const until=Date.now()+20000;let stable=null;
   while(Date.now()<until){if(disconnected||controller.signal.aborted)throw Error('Verbinding verbroken of afgebroken.');if(/(?:^|\n)[\w.-]+(?:\([^\n]*\))?[#>]\s*$/.test(buffer.replace(/\r/g,'\n'))){if(stable===buffer)return buffer;stable=buffer;}else stable=null;await new Promise(r=>setTimeout(r,120));}
   throw Error('Geen volledig consoleantwoord; gestopt zonder herhaling.');
  };
  const result=await sendIOS(source,exchange,{signal:controller.signal,onProgress:(n,total)=>{$('progress').max=total;$('progress').value=n;status(`${n}/${total} opdrachten bevestigd.`);}});status(`Upload afgerond (${result.count} opdrachten). Niet opgeslagen voor herstart.`);
 }catch(e){status(e.message+' Controleer de console; eerdere opdrachten kunnen al actief zijn.');}finally{await release();busy=false;}
};
$('cancel').onclick=()=>{controller.abort();source=null;$('config').textContent='';void release();window.close();};
window.addEventListener('pagehide',()=>{controller.abort();source=null;accept=null;clearTimeout(timeout);void release();});
