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
const SNMP_USER='zbx2026';
const SNMP_GROUP='ZBX2026';
const SNMP_VIEW=`snmp-server view ${SNMP_GROUP} iso included`;
const SNMP_ACL='ip access-list standard SNMP_ZABBIX';
const SNMP_GROUP_LINE=`snmp-server group ${SNMP_GROUP} v3 priv read ${SNMP_GROUP} access SNMP_ZABBIX`;
const SNMP_LOOKUP=`show snmp user ${SNMP_USER}`;
const SNMP_ENGINE=/^(?:no[ \t]+)?snmp-server[ \t]+engineid[ \t]+local(?:[ \t]|$)/i;
const SNMP_GROUP_DECLARATION=/^snmp-server[ \t]+group[ \t]+zbx2026(?:[ \t]|$)/i;
const SNMP_CONFLICT=/^(?:snmp-server[ \t]+user[ \t]+zbx2026|no[ \t]+(?:snmp-server|ip[ \t]+access-list[ \t]+standard[ \t]+snmp_zabbix))(?:[ \t]|$)/i;
const SNMP_ACL_RULE=/^(?:\d+[ \t]+)?(?:permit|deny|remark)[ \t]/i;
const SNMP_ACL_PERMIT=/^(?:\d+[ \t]+)?permit[ \t]/i;

function snmpUserCommand(auth,priv){
 return `snmp-server user ${SNMP_USER} ${SNMP_GROUP} v3 auth sha ${auth} priv aes 128 ${priv}`;
}

export function validSNMPCredential(value){
 return typeof value==='string'&&/^[A-Za-z0-9!_-]{8,64}$/.test(value)&&!/^change[-_]?me$/i.test(value);
}

export function describeSNMP(plan){
 const commands=Array.isArray(plan?.commands)?plan.commands:[];
 const groups=commands.filter(line=>SNMP_GROUP_DECLARATION.test(line));
 const conflicts=commands.some(line=>SNMP_CONFLICT.test(line)&&!SNMP_ENGINE.test(line));
 if(conflicts||groups.length!==1||groups[0].replace(/[ \t]+/g,' ')!==SNMP_GROUP_LINE) return null;
 const normalized=commands.map(line=>line.replace(/[ \t]+/g,' '));
 const view=normalized.indexOf(SNMP_VIEW);
 const acl=normalized.indexOf(SNMP_ACL);
 if(view<0||acl<0||normalized.lastIndexOf(SNMP_ACL)!==acl) return null;
 const aclLines=[];
 for(const line of commands.slice(acl+1)){
  if(!SNMP_ACL_RULE.test(line)) break;
  aclLines.push(line);
 }
 if(!aclLines.some(line=>SNMP_ACL_PERMIT.test(line))) return null;
 return {
  lines:[commands[view],groups[0],commands[acl],...aclLines.map(line=>' '+line),snmpUserCommand('[afgeschermd]','[afgeschermd]')],
  operationCount:3,
  excludesEngineId:plan.snmpEngineIdCount>0||commands.some(line=>SNMP_ENGINE.test(line)),
 };
}

async function readSNMPUser(exchange,prompt){
 const message='Het SNMP-profiel op het fysieke toestel kon niet veilig worden bevestigd.';
 let reply;
 try{reply=await exchange(SNMP_LOOKUP);}catch{throw Error(message);}
 if(typeof reply!=='string')throw Error(message);
 const lines=reply.replace(/\r/g,'\n').split('\n').map(line=>line.trim()).filter(Boolean);
 if(lines.pop()!==prompt)throw Error(message);
 const echo=lines.shift();
 if(echo!==SNMP_LOOKUP&&!(echo?.startsWith(prompt)&&echo.slice(prompt.length).trimStart()===SNMP_LOOKUP))throw Error(message);
 if(!lines.length) return 'missing';
 const fields=new Map();
 for(const line of lines){
  const match=/^(user name|engine id|storage-type|authentication protocol|privacy protocol|group[- ]name|rowstatus):[ \t]*(.+)$/i.exec(line);
  const key=match?.[1].toLowerCase().replace('-', ' ');
  if(!key||fields.has(key))throw Error(message);
  fields.set(key,match[2]);
 }
 if(fields.get('user name')!==SNMP_USER||fields.get('group name')!==SNMP_GROUP||
    !/^(?:0x)?[a-f0-9]+$/i.test(fields.get('engine id'))||!/^nonvolatile[ \t]+active$/i.test(fields.get('storage type'))||
    !/^sha(?:-?1)?$/i.test(fields.get('authentication protocol'))||!/^aes[- ]?128$/i.test(fields.get('privacy protocol'))||
    (fields.has('rowstatus')&&!/^active$/i.test(fields.get('rowstatus')))) throw Error(message);
 return 'matching';
}

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

export function prepareRunning(raw,{excludeNoIpRouting=false,excludeVirtualSNMPEngineId=false}={}){
 if(typeof raw!=='string'||raw.length>2*1024*1024||INVALID_WIRE_CHAR.test(raw.replace(/\r/g,'')))throw Error('Geen geldige tekstconfig ontvangen.');
 if(/^\s*</.test(raw)||/\b(?:MASKED|REDACTED|CHANGEME)\b|<(?:PASSWORD|SECRET|COMMUNITY|SNMP[^>]*)>/i.test(raw))throw Error('Dit is XML, een template of een gemaskeerde export.');
 const lines=raw.replace(/\r\n?/g,'\n').split('\n');let i=0;
 while(i<lines.length&&(!lines[i].trim()||/^\s*!/.test(lines[i])||/^\s*(?:Building configuration\.\.\.|Current configuration\s*:\s*\d+ bytes|show running-config)\s*$/.test(lines[i])))i++;
 if(!/^version\s+\S/.test(lines[i]||''))throw Error('Geen volledige IOS running-config ontvangen.');
 const commands=[],saveCommands=[],excludedSaveCommands=[];
 const excludedLines=new Set(),excludedLinesWithSaves=new Set();
 const noIpRoutingCommands=new Set();
 const snmpEngineIdCommands=new Set();
 let hostname=null;
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
  if(/^no[ \t]+ip[ \t]+routing[ \t]*$/i.test(lines[i])){
   noIpRoutingCommands.add(commands.length);
   if(excludeNoIpRouting){
    excludedLines.add(i);
    excludedLinesWithSaves.add(i);
   }
  }
  if(SNMP_ENGINE.test(line)){
   snmpEngineIdCommands.add(commands.length);
   if(excludeVirtualSNMPEngineId){excludedLines.add(i);excludedLinesWithSaves.add(i);}
  }
  if(savesConfiguration(line)){
   excludedSaveCommands.push(line);
   excludedLines.add(i);
   const canonical=line.toLowerCase().replace(/[ \t]+/g,' ');
   if(SUPPORTED_SAVE_COMMANDS.has(canonical))saveCommands.push(canonical);
   else excludedLinesWithSaves.add(i);
   continue;
  }
  if(!validUploadCommand(line))throw Error('De bron bevat een uitvoeringsopdracht in plaats van alleen running-config.');
  if(/^hostname\s+/.test(line)){if(hostname)throw Error('Meerdere hostnames in de bron.');hostname=line.split(/\s+/)[1];}
  commands.push(line);
 }
 if(!hostname||!endsInConfigEnd(commands))throw Error('De running-config heeft geen geldige afsluiting.');
 const uploadCommands=commands.filter((_,index)=>!(excludeNoIpRouting&&noIpRoutingCommands.has(index))&&
  !(excludeVirtualSNMPEngineId&&snmpEngineIdCommands.has(index)));
 const config=excludedLines.size?lines.filter((_,index)=>!excludedLines.has(index)).join('\n'):raw;
 const configWithSaves=excludedLinesWithSaves.size?lines.filter((_,index)=>!excludedLinesWithSaves.has(index)).join('\n'):raw;
 return {
  hostname,commands:uploadCommands,config,configWithSaves,saveCommands,excludedSaveCommands,
  noIpRoutingCount:noIpRoutingCommands.size,snmpEngineIdCount:snmpEngineIdCommands.size,bytes:new TextEncoder().encode(raw).byteLength,
 };
}
export async function sendIOS(plan,exchange,{signal,includeSaveCommands=false,snmpProfile,onProgress=()=>{}}={}){
 const commands=Array.isArray(plan?.commands)?plan.commands.filter(line=>!snmpProfile||!SNMP_ENGINE.test(line)):[];
 if(!commands.every(validUploadCommand)||!endsInConfigEnd(commands))throw Error('De upload bevat een geblokkeerde of onvolledige opdracht.');
 if(snmpProfile&&(!describeSNMP(plan)||!validSNMPCredential(snmpProfile.auth)||!validSNMPCredential(snmpProfile.priv))){
  throw Error('Het SNMP-profiel of de ingevulde sleutels zijn ongeldig.');
 }
 const saves=includeSaveCommands===true?plan.saveCommands:[];
 if(!Array.isArray(saves)||!saves.every(command=>SUPPORTED_SAVE_COMMANDS.has(command)))throw Error('De upload bevat een onbekende opslagopdracht.');
 const saveCommands=[...saves];
 const send=['configure terminal',...commands];
 let count=0;const check=()=>{if(signal?.aborted)throw Error(`Afgebroken na ${count} opdrachten. Eerdere regels kunnen al actief zijn.`);};
 check();
 const initial=await exchange('\r');
 const prompt=initial.replace(/\r/g,'\n').trimEnd().split('\n').at(-1);
 if(/^[\w.-]+>$/.test(prompt))throw Error('De switch staat op een IOS-prompt met >. Typ enable in de fysieke console tot je de gewone #‑prompt ziet.');
 if(CONFIG_PROMPT.test(prompt))throw Error('De console staat in een configuratiemodus. Typ end in de fysieke console tot je de gewone #‑prompt ziet.');
 if(!EXEC_PROMPT.test(prompt))throw Error('Het fysieke toestel moet op een normale IOS-prompt met # staan. Controleer de gekozen COM-poort en de aanmelding.');
 let addUser=false;
 if(snmpProfile){check();addUser=await readSNMPUser(exchange,prompt)==='missing';}
 const total=send.length+saveCommands.length+(addUser?3:0);
 async function sendCommand(command,{exactPrompt,sensitive=false}={}){
  check();
  let reply;
  try{reply=await exchange(command);}catch(error){
   if(sensitive)throw Error(`De SNMP-gebruikersregel kon niet worden bevestigd bij opdracht ${count+1}.`);
   throw error;
  }
  if(IOS_ERROR.test(reply)){
   const label=DISPLAYABLE_IOS_ERRORS.has(command)?` (${command})`:'';
   if(sensitive)throw Error(`IOS weigerde de SNMP-gebruikersregel bij opdracht ${count+1}.`);
   throw Error(`IOS weigerde opdracht ${count+1}${label}.`);
  }
  const tail=reply.replace(/\r/g,'\n').trimEnd().split('\n').at(-1)||'';
  const expectedPrompt=command==='end'?EXEC_PROMPT:CONFIG_PROMPT;
  if(!expectedPrompt.test(tail)||(exactPrompt&&tail!==exactPrompt)){
   if(sensitive)throw Error(`Onverwachte IOS-prompt bij de SNMP-gebruikersregel ${count+1}.`);
   throw Error(`Onverwachte IOS-prompt na opdracht ${count+1}. Gestopt zonder herhaling.`);
  }
  count++;onProgress(count,total);
  return tail;
 }
 let tail=prompt;
 for(const command of send)tail=await sendCommand(command);
 if(snmpProfile){
  if(tail!==`${plan.hostname}#`)throw Error('De ingestelde hostname kon niet worden bevestigd voor het SNMP-profiel.');
  if(addUser){
   const configPrompt=`${tail.slice(0,-1)}(config)#`;
   await sendCommand('configure terminal',{exactPrompt:configPrompt});
   await sendCommand(snmpUserCommand(snmpProfile.auth,snmpProfile.priv),{exactPrompt:configPrompt,sensitive:true});
   await sendCommand('end',{exactPrompt:tail});
  }
  check();
  if(await readSNMPUser(exchange,tail)!=='matching')throw Error('De SNMP-gebruikersregel werd achteraf niet bevestigd. Controleer de fysieke console.');
  check();
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
 return {count,saved:saveCommands.length>0,...(snmpProfile?{snmpProfile:addUser?'configured':'existing'}:{})};
}
export function receiver(origin,source,job){let used=false;return event=>{const d=event.data;if(used||!source||event.source!==source||event.origin!==origin||d?.version!==1||d.type!=='running'||d.job!==job||typeof d.name!=='string'||d.name.length>100)return null;const plan=prepareRunning(d.config);used=true;return {...plan,rawConfig:d.config,name:d.name,prepared:d.prepared===true};};}
