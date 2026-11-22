// One owner for every serial operation, including operations finishing after Stop.
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const now=()=>performance.now();
export class SerialSession {
 constructor(port,{operationMs=20000,cleanupMs=400,pollMs=120,onData,onDisconnect}={}){
  this.port=port;
  this.operationMs=operationMs;
  this.cleanupMs=cleanupMs;
  this.pollMs=pollMs;
  this.onData=onData;
  this.onDisconnect=onDisconnect;
  this.controller=new AbortController();
  this.response=null;
  this.busy=false;
  this.wrote=false;
  this.opened=false;
  this.closing=false;
  this.reason=null;
  this.reader=null;
  this.writer=null;
  this.reading=null;
  this.writing=null;
  this.opening=null;
  this.closeJob=null;
  this.closed=new Promise(resolve=>this.resolveClosed=resolve);
 }
 guard(){if(this.reason)throw this.reason;if(this.closing)throw Error('De consoleverbinding is gesloten.');}
 stop(reason=Error('Afgebroken.')){if(!this.reason)this.reason=reason;this.controller.abort(this.reason);this.beginClose();}
 notify(callback,value){
  // UI callbacks report data and disconnects without taking ownership of the port.
  if(!callback)return;
  try{Promise.resolve(callback(value)).catch(()=>{});}catch{}
 }
 fail(error){
  if(this.closing)return;
  this.stop(error);
  this.notify(this.onDisconnect,error);
 }
 wait(work,deadline){
  return new Promise((resolve,reject)=>{
   let done=false;
   const signal=this.controller.signal;
   let timer;
   const finish=(fn,value)=>{
    if(done)return;
    done=true;
    clearTimeout(timer);
    signal.removeEventListener('abort',abort);
    fn(value);
   };
   const abort=()=>finish(reject,this.reason||Error('Afgebroken.'));
   signal.addEventListener('abort',abort,{once:true});
   timer=setTimeout(()=>this.fail(Error('De consolebewerking duurde te lang; gestopt zonder herhaling.')),Math.max(0,deadline-now()));
   Promise.resolve(work).then(v=>finish(resolve,v),e=>finish(reject,e));
   if(signal.aborted)abort();
  });
 }
 async open(options){
  this.guard();
  if(this.opening)throw Error('De consolepoort wordt al gebruikt.');
  this.opening=Promise.resolve().then(()=>{
   this.guard();
   return this.port.open(options);
  }).then(()=>{this.opened=true;});
  try{
   await this.wait(this.opening,now()+this.operationMs);
   this.guard();
   const {readable,writable}=this.port;
   if(!readable||!writable)throw Error('De consolepoort heeft geen lees- of schrijfstroom.');
   this.writer=writable.getWriter();
   this.reader=readable.getReader();
   this.writer.closed.then(
    ()=>this.fail(Error('Consoleverbinding verbroken.')),
    error=>this.fail(error)
   );
   this.reading=this.read(this.reader);
  }catch(error){
   if(this.opened)this.fail(error);
   else if(!this.closing)this.stop(error);
   throw error;
  }
 }
 async read(reader){
  const decoder=new TextDecoder();
  try{
   while(!this.closing){
    const {value,done}=await reader.read();
    if(this.closing)break;
    const chunk=done?decoder.decode():decoder.decode(value,{stream:true});
    if(chunk){
     if(this.response!==null)this.response+=chunk;
     this.notify(this.onData,chunk);
    }
    if(this.response?.length>2*1024*1024){
     this.fail(Error('Consolelimiet bereikt.'));
     break;
    }
    if(done){
     this.fail(Error('Consoleverbinding verbroken.'));
     break;
    }
   }
  }catch(error){
   this.fail(Error('Consoleverbinding verbroken.',{cause:error}));
  }finally{try{reader.releaseLock();}catch{}}
 }
 guardOperation(){
  this.guard();
  if(this.busy)throw Error('Er loopt al een consolebewerking.');
  if(!this.writer)throw Error('De consolepoort is niet geopend.');
 }
 async write(bytes,deadline){
  const writer=this.writer;
  this.writing=Promise.resolve().then(()=>{
   this.guard();
   this.wrote=true;
   return writer.write(bytes);
  });
  try{
   await this.wait(this.writing,deadline);
   this.guard();
  }catch(error){
   this.fail(error);
   throw error;
  }
 }
 async sendInput(value){
  this.guardOperation();
  const bytes=typeof value==='string'?new TextEncoder().encode(value):value;
  if(!ArrayBuffer.isView(bytes)&&!(bytes instanceof ArrayBuffer))throw new TypeError('Ongeldige console-invoer.');
  this.busy=true;
  try{await this.write(bytes,now()+this.operationMs);}
  finally{this.busy=false;}
 }
 async exchange(command,{acceptAdditionalPrompt}={}){
  this.guardOperation();
  const deadline=now()+this.operationMs;
  const bytes=new TextEncoder().encode(command==='\r'?command:command.replace(/\n/g,'\r')+'\r');
  this.busy=true;
  this.response='';
  try{
   await this.write(bytes,deadline);
   let stable=null;
   while(true){
    this.guard();
    const response=this.response;
    if(/(?:^|\n)[\w.-]+(?:\([^\n]*\))?[#>]\s*$/.test(response.replace(/\r/g,'\n'))||acceptAdditionalPrompt?.(response)){
     if(stable===response)return response;
     stable=response;
    }else stable=null;
    await this.wait(pause(this.pollMs),deadline);
   }
  }finally{
   this.response=null;
   this.busy=false;
  }
 }
 beginClose(){
  if(this.closeJob)return;this.closing=true;this.response=null;this.controller.abort(this.reason||Error('De consoleverbinding wordt gesloten.'));
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
   await Promise.allSettled([closing,this.writing,abortWrite]);return {complete:!closeError};
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
