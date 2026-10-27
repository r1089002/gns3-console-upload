export function prepareRunning(raw){
 if(typeof raw!=='string'||raw.length>2*1024*1024||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(raw))throw Error('Geen geldige tekstconfig ontvangen.');
 if(/^\s*</.test(raw)||/\b(?:MASKED|REDACTED|CHANGEME)\b|<(?:PASSWORD|SECRET|COMMUNITY|SNMP[^>]*)>/i.test(raw))throw Error('Dit is XML, een template of een gemaskeerde export.');
 const lines=raw.replace(/\r\n?/g,'\n').split('\n');let i=0;
 while(i<lines.length&&(!lines[i].trim()||/^\s*(?:!|Building configuration\.\.\.|Current configuration\s*:\s*\d+ bytes|show running-config)\s*$/.test(lines[i])))i++;
 if(!/^version\s+\S/.test(lines[i]||''))throw Error('Geen volledige IOS running-config ontvangen.');
 const commands=[];let hostname=null;
 for(;i<lines.length;i++){
  const line=lines[i].trim();if(!line||line.startsWith('!'))continue;
  const banner=/^banner\s+(\S+)\s+(\^[A-Za-z@\[\\\]^_?]|.)(.*)$/.exec(line);
  if(banner){
   const delimiter=banner[2];let body=banner[3],end=body.indexOf(delimiter);
   while(end<0&&++i<lines.length){body+='\n'+lines[i];end=body.indexOf(delimiter);}
   if(end<0||body.slice(end+delimiter.length).trim())throw Error('Onvolledige banner in de export.');
   body=body.slice(0,end);const safe=['#','%','~','|','$','@'].find(c=>!body.includes(c));if(!safe)throw Error('Banner kan niet veilig worden doorgestuurd.');
   commands.push(`banner ${banner[1]} ${safe}${body}${safe}`);continue;
  }
  if(/^(?:write|copy|erase|reload|format|delete|configure|conf)\b/i.test(line))throw Error('De bron bevat een uitvoeringsopdracht in plaats van alleen running-config.');
  if(/^hostname\s+/.test(line)){if(hostname)throw Error('Meerdere hostnames in de bron.');hostname=line.split(/\s+/)[1];}
  commands.push(line);
 }
 if(!hostname||commands.at(-1)!=='end')throw Error('De running-config is onvolledig.');
 return {hostname,commands,bytes:new TextEncoder().encode(raw).byteLength};
}
export async function sendIOS(plan,exchange,{signal,onProgress=()=>{}}={}){
 let count=0;const check=()=>{if(signal?.aborted)throw Error(`Afgebroken na ${count} opdrachten. Eerdere regels kunnen al actief zijn.`);};
 check();const initial=await exchange('\r');if(!/(?:^|\n)[\w.-]+#\s*$/.test(initial.replace(/\r/g,'\n'))||/@/.test(initial.split(/[\r\n]/).at(-1)))throw Error('Het fysieke toestel moet al op een normale IOS # prompt staan.');
 for(const command of ['configure terminal',...plan.commands]){
  check();const reply=await exchange(command);
  if(/(?:^|[\r\n])\s*(?:%\s*(?:Invalid|Incomplete|Ambiguous|Error)|Error:)/i.test(reply))throw Error(`IOS-fout. Gestopt na ${count} bevestigde opdrachten; eerdere regels kunnen actief zijn.`);
  const tail=reply.replace(/\r/g,'\n').trimEnd().split('\n').at(-1)||'';
  if(!/^[\w.-]+(?:\([^\n]*\))?#$/.test(tail))throw Error(`Geen volledige IOS-prompt na opdracht ${count+1}. Gestopt zonder herhaling.`);
  count++;onProgress(count,plan.commands.length+1);
 }
 return {count,saved:false};
}
export function receiver(origin,source,job){let used=false;return event=>{const d=event.data;if(used||!source||event.source!==source||event.origin!==origin||d?.version!==1||d.type!=='running'||d.job!==job||typeof d.name!=='string'||d.name.length>100)return null;const plan=prepareRunning(d.config);used=true;return {...plan,name:d.name,config:d.config};};}
