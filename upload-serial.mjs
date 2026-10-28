// One owner for every serial operation, including operations finishing after Stop.
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const now=()=>performance.now();
export class SerialSession {
 constructor(port,{operationMs=20000,cleanupMs=400,pollMs=120}={}){
  this.port=port;this.operationMs=operationMs;this.cleanupMs=cleanupMs;this.pollMs=pollMs;this.controller=new AbortController();this.buffer='';this.wrote=false;this.opened=false;this.closing=false;this.reason=null;this.reader=null;this.writer=null;this.reading=null;this.writing=null;this.opening=null;this.closeJob=null;this.closed=new Promise(resolve=>this.resolveClosed=resolve);
 }
 guard(){if(this.reason)throw this.reason;if(this.closing)throw Error('De consoleverbinding is gesloten.');}
 stop(reason=Error('Afgebroken.')){if(!this.reason)this.reason=reason;this.controller.abort(this.reason);this.beginClose();}
 wait(work,deadline){
  return new Promise((resolve,reject)=>{let done=false;const signal=this.controller.signal;let timer;const finish=(fn,value)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);fn(value);};const abort=()=>finish(reject,this.reason||Error('Afgebroken.'));signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>this.stop(Error('De consolebewerking duurde te lang; gestopt zonder herhaling.')),Math.max(0,deadline-now()));Promise.resolve(work).then(v=>finish(resolve,v),e=>finish(reject,e));if(signal.aborted)abort();});
 }
 async open(options){
  this.guard();this.opening=Promise.resolve().then(()=>{this.guard();return this.port.open(options);}).then(()=>{this.opened=true;});await this.wait(this.opening,now()+this.operationMs);this.guard();
  this.writer=this.port.writable.getWriter();this.reader=this.port.readable.getReader();const reader=this.reader,decoder=new TextDecoder();
  this.reading=(async()=>{try{while(!this.closing){const {value,done}=await reader.read();if(this.closing)break;if(done){if(!this.closing)this.stop(Error('Consoleverbinding verbroken.'));break;}this.buffer+=decoder.decode(value,{stream:true});if(this.buffer.length>2*1024*1024)throw Error('Consolelimiet bereikt.');}}catch(error){if(!this.closing)this.stop(Error('Consoleverbinding verbroken.'));}finally{try{reader.releaseLock();}catch{}}})();
 }
 async exchange(command){
  this.guard();const deadline=now()+this.operationMs;this.buffer='';const writer=this.writer;if(!writer)throw Error('De consolepoort is niet geopend.');
  this.writing=Promise.resolve().then(()=>{this.guard();this.wrote=true;return writer.write(new TextEncoder().encode(command==='\r'?command:command.replace(/\n/g,'\r')+'\r'));});
  await this.wait(this.writing,deadline);this.guard();let stable=null;
  while(true){this.guard();if(/(?:^|\n)[\w.-]+(?:\([^\n]*\))?[#>]\s*$/.test(this.buffer.replace(/\r/g,'\n'))){if(stable===this.buffer)return this.buffer;stable=this.buffer;}else stable=null;await this.wait(pause(this.pollMs),deadline);}
 }
 beginClose(){
  if(this.closeJob)return;this.closing=true;this.buffer='';this.controller.abort(this.reason||Error('De consoleverbinding wordt gesloten.'));
  this.closeJob=(async()=>{
   // A late successful open is owned here and closed, never used for writes.
   try{await this.opening;}catch{}
   if(!this.opened)return {complete:true};
   const reader=this.reader,writer=this.writer;let cancelRead=Promise.resolve(),abortWrite=Promise.resolve();
   if(reader)try{cancelRead=Promise.resolve(reader.cancel()).catch(()=>{});}catch{}
   if(writer){try{abortWrite=Promise.resolve(writer.abort(this.reason||Error('Verbinding sluiten.'))).catch(()=>{});}catch{}try{writer.releaseLock();}catch{}}
   this.reader=null;this.writer=null;
   await Promise.allSettled([cancelRead,this.reading]);
   // Ask the port to close after locks are released. Still observe the pending
   // write/abort as well; a resolved close alone does not prove all I/O settled.
   let closeError=null;const closing=Promise.resolve().then(()=>this.port.close()).catch(e=>{closeError=e;});
   await Promise.allSettled([closing,this.writing,abortWrite]);this.buffer='';return {complete:!closeError};
  })().catch(()=>({complete:false}));this.closeJob.then(this.resolveClosed);
 }
 async close(){this.beginClose();let timer;try{return await Promise.race([this.closed,new Promise(resolve=>{timer=setTimeout(()=>resolve({complete:false,pending:true}),this.cleanupMs);})]);}finally{clearTimeout(timer);}}
}
export function serialErrorMessage(error){
 if(error?.name==='NotFoundError')return 'Poortkeuze geannuleerd. Er is niets verstuurd.';
 if(['NetworkError','InvalidStateError'].includes(error?.name))return 'De COM-poort kan niet worden gebruikt. Sluit PuTTY of andere consoles en controleer de USB-consolekabel.';
 if(['SecurityError','NotAllowedError'].includes(error?.name))return 'De browser heeft geen toegang tot de COM-poort. Geef toestemming in Chrome of Edge en probeer opnieuw.';
 return typeof error?.message==='string'?error.message:'De consolebewerking is onderbroken.';
}
