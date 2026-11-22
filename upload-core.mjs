const EXEC_COMMANDS=['write','copy','save','erase','reload','format','delete','configure','do'];
const BANNER_DELIMITERS=['#','%','~','|','$','@'];
const INVALID_WIRE_CHAR=/[\x00-\x08\x0b-\x1f\x7f]/;
const COPY_TO_STARTUP='copy running-config startup-config';
const SUPPORTED_SAVE_COMMANDS=new Set(['write memory',COPY_TO_STARTUP]);
const STARTUP_FILENAME_PROMPT=/(?:^|[\r\n])\s*Destination file\s?name \[startup-config\]\?\s*$/i;
const IOS_ERROR=/(?:^|[\r\n])\s*(?:%\s*(?:Invalid|Incomplete|Ambiguous|Error)|Error:)/i;
const DISPLAYABLE_IOS_ERRORS=new Set([
 'configure terminal','no ip routing','no ip cef','no ipv6 cef',
 'service compress-config','negotiation auto','switchport trunk encapsulation dot1q','spanning-tree portfast edge',
]);
const EXEC_PROMPT=/^[\w.-]+#$/;
const CONFIG_PROMPT=/^[\w.-]+\([^\n]+\)#$/;

function prefix(value,command){return Boolean(value)&&command.startsWith(value);}
function words(line){return line.replace(/\?/g,'').trim().toLowerCase().split(/\s+/);}
function savesConfiguration(line){
 const tokens=words(line);
 if(prefix(tokens[0],'do'))tokens.shift();
 const [verb,arg,dest]=tokens;
 if(prefix(verb,'write'))return !arg||prefix(arg,'memory');
 if(prefix(verb,'save'))return true;
 if(!prefix(verb,'copy')||!dest)return false;
 const target=dest.replace(/^["']|["']$/g,'');
 return prefix(target,'startup-config')||target.startsWith('nvram:');
}

function executable(line){return EXEC_COMMANDS.some(command=>prefix(words(line)[0],command));}

function validUploadCommand(command){
 if(typeof command!=='string'||!command||command!==command.trim()||INVALID_WIRE_CHAR.test(command))return false;
 const banner=/^banner[ \t]+\S+[ \t]+([#%~|$@])([\s\S]*)$/.exec(command);
 if(banner){
  const [,delimiter,content]=banner;
  const end=content.indexOf(delimiter);
  return end>=0&&end===content.length-1&&!content.slice(0,end).split('\n').some(savesConfiguration);
 }
 return !command.includes('\n')&&!/^banner\b/i.test(command)&&!executable(command);
}

function endsInConfigEnd(commands){
 return commands.at(-1)==='end'&&commands.findIndex(command=>words(command)[0]==='end')===commands.length-1;
}

export function prepareRunning(raw){
 if(typeof raw!=='string'||raw.length>2*1024*1024||INVALID_WIRE_CHAR.test(raw.replace(/\r/g,'')))throw Error('Geen geldige tekstconfig ontvangen.');
 if(/^\s*</.test(raw)||/\b(?:MASKED|REDACTED|CHANGEME)\b|<(?:PASSWORD|SECRET|COMMUNITY|SNMP[^>]*)>/i.test(raw))throw Error('Dit is XML, een template of een gemaskeerde export.');
 const lines=raw.replace(/\r\n?/g,'\n').split('\n');let i=0;
 while(i<lines.length&&(!lines[i].trim()||/^\s*!/.test(lines[i])||/^\s*(?:Building configuration\.\.\.|Current configuration\s*:\s*\d+ bytes|show running-config)\s*$/.test(lines[i])))i++;
 if(!/^version\s+\S/.test(lines[i]||''))throw Error('Geen volledige IOS running-config ontvangen.');
 const commands=[],saveCommands=[],excludedSaveCommands=[];
 const excludedLines=new Set(),unsupportedSaveLines=new Set();let hostname=null;
 for(;i<lines.length;i++){
  const line=lines[i].trim();if(!line||line.startsWith('!'))continue;
  const banner=/^banner\s+(\S+)\s+(\^[A-Za-z@\[\\\]^_?]|.)(.*)$/.exec(line);
  if(banner){
   const delimiter=banner[2];let body=banner[3],end=body.indexOf(delimiter);
   while(end<0&&++i<lines.length){body+='\n'+lines[i];end=body.indexOf(delimiter);}
   if(end<0||body.slice(end+delimiter.length).trim())throw Error('Onvolledige banner in de export.');
   body=body.slice(0,end);const safe=BANNER_DELIMITERS.find(c=>!body.includes(c));
   const command=`banner ${banner[1]} ${safe}${body}${safe}`;
   if(!safe||!validUploadCommand(command))throw Error('Banner kan niet veilig worden doorgestuurd.');
   commands.push(command);continue;
  }
  if(savesConfiguration(line)){
   excludedSaveCommands.push(line);
   excludedLines.add(i);
   const canonical=line.toLowerCase().replace(/[ \t]+/g,' ');
   if(SUPPORTED_SAVE_COMMANDS.has(canonical))saveCommands.push(canonical);
   else unsupportedSaveLines.add(i);
   continue;
  }
  if(!validUploadCommand(line))throw Error('De bron bevat een uitvoeringsopdracht in plaats van alleen running-config.');
  if(/^hostname\s+/.test(line)){if(hostname)throw Error('Meerdere hostnames in de bron.');hostname=line.split(/\s+/)[1];}
  commands.push(line);
 }
 if(!hostname||!endsInConfigEnd(commands))throw Error('De running-config heeft geen geldige afsluiting.');
 const config=excludedLines.size?lines.filter((_,index)=>!excludedLines.has(index)).join('\n'):raw;
 const configWithSaves=unsupportedSaveLines.size?lines.filter((_,index)=>!unsupportedSaveLines.has(index)).join('\n'):raw;
 return {hostname,commands,config,configWithSaves,saveCommands,excludedSaveCommands,bytes:new TextEncoder().encode(raw).byteLength};
}
export async function sendIOS(plan,exchange,{signal,includeSaveCommands=false,onProgress=()=>{}}={}){
 const commands=Array.isArray(plan?.commands)?[...plan.commands]:[];
 if(!commands.every(validUploadCommand)||!endsInConfigEnd(commands))throw Error('De upload bevat een geblokkeerde of onvolledige opdracht.');
 const saves=includeSaveCommands===true?plan.saveCommands:[];
 if(!Array.isArray(saves)||!saves.every(command=>SUPPORTED_SAVE_COMMANDS.has(command)))throw Error('De upload bevat een onbekende opslagopdracht.');
 const saveCommands=[...saves];
 const send=['configure terminal',...commands];
 const total=send.length+saveCommands.length;
 let count=0;const check=()=>{if(signal?.aborted)throw Error(`Afgebroken na ${count} opdrachten. Eerdere regels kunnen al actief zijn.`);};
 check();
 const initial=await exchange('\r');
 const prompt=initial.replace(/\r/g,'\n').trimEnd().split('\n').at(-1);
 if(/^[\w.-]+>$/.test(prompt))throw Error('De switch staat op een IOS-prompt met >. Typ enable in de fysieke console tot je de gewone #‑prompt ziet.');
 if(CONFIG_PROMPT.test(prompt))throw Error('De console staat in een configuratiemodus. Typ end in de fysieke console tot je de gewone #‑prompt ziet.');
 if(!EXEC_PROMPT.test(prompt))throw Error('Het fysieke toestel moet op een normale IOS-prompt met # staan. Controleer de gekozen COM-poort en de aanmelding.');
 for(const command of send){
  check();const reply=await exchange(command);
  if(IOS_ERROR.test(reply)){
   const label=DISPLAYABLE_IOS_ERRORS.has(command)?` (${command})`:'';
   throw Error(`IOS weigerde opdracht ${count+1}${label}.`);
  }
  const tail=reply.replace(/\r/g,'\n').trimEnd().split('\n').at(-1)||'';
  const expectedPrompt=command==='end'?EXEC_PROMPT:CONFIG_PROMPT;
  if(!expectedPrompt.test(tail))throw Error(`Onverwachte IOS-prompt na opdracht ${count+1}. Gestopt zonder herhaling.`);
  count++;onProgress(count,total);
 }
 for(const command of saveCommands){
  check();
  const isCopy=command===COPY_TO_STARTUP;
  let reply=await exchange(command,isCopy?{acceptAdditionalPrompt:text=>STARTUP_FILENAME_PROMPT.test(text)}:undefined);
  if(isCopy&&!IOS_ERROR.test(reply)&&STARTUP_FILENAME_PROMPT.test(reply)){
   check();
   reply=await exchange('\r');
  }
  const tail=reply.replace(/\r/g,'\n').trimEnd().split('\n').at(-1)||'';
  if(IOS_ERROR.test(reply)||!EXEC_PROMPT.test(tail)||!/\[OK\]|\b\d+ bytes copied\b/i.test(reply)){
   throw Error('Opslaan als startup-config is niet bevestigd. Controleer de switch.');
  }
  count++;onProgress(count,total);
 }
 return {count,saved:saveCommands.length>0};
}
export function receiver(origin,source,job){let used=false;return event=>{const d=event.data;if(used||!source||event.source!==source||event.origin!==origin||d?.version!==1||d.type!=='running'||d.job!==job||typeof d.name!=='string'||d.name.length>100)return null;const plan=prepareRunning(d.config);used=true;return {...plan,name:d.name,prepared:d.prepared===true};};}
