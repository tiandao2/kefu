const $ = id => document.getElementById(id);
const list=$('message-list'),scroller=$('messages'),input=$('message-input'),sendButton=$('send-button');
const messages=new Map(),pending=new Map(),visible=new Set(),reported=new Set();
const rowCache=new Map();
// Local revisions order HTTP snapshots against events received while in flight.
const messageChanges=new Map(),removedMessages=new Set();
let changeSequence=0,syncSequence=0,initializationSequence=0;
let ready=false,selectedFile=null,sending=false,ws=null,reconnectDelay=1000,reconnectTimer=null,readTimer=null,toastTimer=null,serverOffset=0;
const MAX=20*1024*1024,DAY=86400000;
const clock=()=>Date.now()+serverOffset;
const size=n=>n>=1024*1024?`${(n/1024/1024).toFixed(1)} MB`:`${Math.max(1,Math.round(n/1024))} KB`;
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
function connection(ok,text){$('status-dot').classList.toggle('connected',ok);$('connection-label').textContent=text;}
async function api(url,body){
 const controller=typeof AbortController==='function'?new AbortController():null;
 let timer;
 const timeout=new Promise((resolve,reject)=>{timer=setTimeout(()=>{const error=new Error('请求超时，请稍后重试');error.name='TimeoutError';reject(error);if(controller)controller.abort();},15000);});
 try{return await Promise.race([(async()=>{
  const options={method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store',credentials:'same-origin'};
  if(controller)options.signal=controller.signal;
  const r=await fetch(url,options);let data;try{data=await r.json();}catch{throw new Error('连接异常，请稍后重试');}if(!r.ok)throw new Error(data.error||'请求失败，请稍后重试');return data;
 })(),timeout]);}finally{clearTimeout(timer);}
}
function bottom(){requestAnimationFrame(()=>{scroller.scrollTop=scroller.scrollHeight;scheduleReads();});}
function updateSend(){sendButton.disabled=!ready||sending||(!input.value.trim()&&!selectedFile);$('attach-button').disabled=sending;}
function element(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function timeLabel(ts){return new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}).format(ts);}
function appendText(parent,text){if(!text)return;const e=element('div','message-text');e.textContent=text;parent.append(e);}
const imageSource=m=>`${m.previewUrl||m.fileUrl+'?preview=1'}&v=${m.editedAt||m.sentAt}`;
function createMessage(m){
 const own=m.direction==='visitor',row=element('article',`message${own?' own':''}${m.local?' pending':''}`);row.dataset.id=m.id;
 const main=element('div','message-main');main.append(element('div','message-sender',own?'您':m.direction==='welcome'?'在线客服 · 欢迎您':$('site-name').textContent));
 const bubble=element('div',`bubble${m.fileUrl&&['image','video'].includes(m.kind)?' media-bubble':''}`);
 if(m.fileUrl){
  if(m.kind==='image'&&['image/jpeg','image/png','image/gif','image/webp','image/avif'].includes(m.previewMime||m.mime)){
   const image=element('img','message-image');image.src=imageSource(m);image.alt=m.filename||'图片';image.loading='lazy';image.decoding='async';image.addEventListener('click',()=>openImage(m));image.addEventListener('load',()=>{if(clock()-m.sentAt<15000)bottom();scheduleReads();});bubble.append(image);
  }else if(m.kind==='video'){
   const video=element('video','message-video');video.src=`${m.fileUrl}?preview=1&v=${m.editedAt||m.sentAt}`;video.controls=true;video.preload='none';video.playsInline=true;bubble.append(video);
  }else{
   const card=element(m.kind==='image'?'div':'a','file-card');if(m.kind!=='image'){card.href=m.fileUrl;card.download=m.filename||'附件';}
   card.append(element('span','file-symbol',(m.filename?.split('.').pop()||'FILE').slice(0,4)));
   const detail=element('span','file-detail');detail.append(element('strong','',m.filename||'附件'),element('small','',size(m.size||0)));card.append(detail);bubble.append(card);
  }
  if(m.kind==='video'){const link=element('a','download-link','下载文件');link.href=m.fileUrl;link.download=m.filename||'附件';bubble.append(link);}
 }
 if(!m.fileUrl&&m.fileStatus&&m.fileStatus!=='ready')bubble.append(element('div','attachment-state',m.fileStatus==='failed'?'附件加载失败':m.fileStatus==='delayed'?'附件加载延迟，正在重试…':'附件加载中…'));
 appendText(bubble,m.body || (m.local && m.file ? `正在发送附件：${m.file.name}` : ''));main.append(bubble);
 const meta=element('div','message-meta');meta.append(element('time','',timeLabel(m.sentAt)));
 if(own){
  if(m.local&&m.failed){const retry=element('button','retry-message','发送失败，点击重试');retry.type='button';retry.addEventListener('click',()=>retryPending(m.id));meta.append(retry);}
  else meta.append(element('span','',m.local?'发送中…':m.status==='sent'?'已发送':m.status==='failed'?'发送失败':m.status==='delayed'?'转发延迟，正在重试':'正在发送至客服…'));
 }
 if(m.status==='failed'||m.fileStatus==='failed'){
  const hint=m.status==='failed'?m.failureReason:m.direction==='visitor'?'图片已发送，预览同步失败':m.fileError;
  if(hint)meta.append(element('span','',hint));
  const retry=element('button','retry-message',m.status==='failed'?'重试发送':'重新加载附件');retry.type='button';retry.addEventListener('click',()=>retryStored(m,retry));meta.append(retry);
 }
 main.append(meta);row.append(main);return row;
}
const observer=new IntersectionObserver(entries=>{for(const entry of entries){const id=entry.target.dataset.id;if(entry.isIntersecting)visible.add(id);else visible.delete(id);}scheduleReads();},{root:scroller,threshold:.01});
function render(){
 const before=scroller.scrollHeight-scroller.scrollTop;
 const all=[...messages.values(),...pending.values()].filter(m=>!m.revoked&&m.sentAt>clock()-DAY).sort((a,b)=>a.sentAt-b.sentAt||a.id.localeCompare(b.id));
 const desired=[],keep=new Set();let date='';
 for(const m of all){
  const day=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric'}).format(m.sentAt);
  if(day!==date){const key=`day:${day}`;keep.add(key);let item=rowCache.get(key);if(!item){item={node:element('div','day-divider',day)};rowCache.set(key,item);}desired.push(item.node);date=day;}
  keep.add(m.id);const signature=JSON.stringify({...m,file:undefined});let item=rowCache.get(m.id);
  if(!item||item.signature!==signature){if(item){observer.unobserve(item.node);visible.delete(m.id);}item={signature,node:createMessage(m)};rowCache.set(m.id,item);}
  desired.push(item.node);if(m.direction==='staff'&&!reported.has(m.id))observer.observe(item.node);
 }
 let cursor=list.firstChild;for(const node of desired){if(cursor===node)cursor=cursor.nextSibling;else list.insertBefore(node,cursor);}
 while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
 for(const [id,item]of rowCache)if(!keep.has(id)){observer.unobserve(item.node);visible.delete(id);item.node.remove();rowCache.delete(id);}
 scroller.scrollTop=Math.max(0,scroller.scrollHeight-before);
 if($('image-dialog').open){
  const current=messages.get($('image-dialog').dataset.id);
  if(!current?.fileUrl||current.kind!=='image')$('image-dialog').close();
  else if($('full-image').getAttribute('src')!==imageSource(current))$('full-image').src=imageSource(current);
 }
}
function put(m,observedAt=changeSequence){
 if(removedMessages.has(m.id)||(messageChanges.get(m.id)||0)>observedAt)return;
 const existing=messages.get(m.id);messages.set(m.id,m);messageChanges.set(m.id,++changeSequence);
 if(m.clientId)pending.delete(m.clientId);
 render();if(!existing)bottom();
}
async function sync(){
 if(!ready)return;
 const observedAt=changeSequence,request=++syncSequence;
 const d=await api('/api/messages');if(request!==syncSequence)return;serverOffset=d.serverTime-Date.now();
 const had=new Set(messages.keys()),received=new Set(d.messages.map(m=>m.id));
 for(const id of had)if(!received.has(id)&&(messageChanges.get(id)||0)<=observedAt)removeMessage(id);
 for(const m of d.messages){
  if(removedMessages.has(m.id)||(messageChanges.get(m.id)||0)>observedAt)continue;
  messages.set(m.id,m);messageChanges.set(m.id,++changeSequence);if(m.clientId)pending.delete(m.clientId);
 }
 render();if(d.messages.some(m=>!had.has(m.id)))bottom();
}
function removeMessage(id){
 messages.delete(id);reported.delete(id);removedMessages.add(id);messageChanges.set(id,++changeSequence);
 if($('image-dialog').dataset.id===id)$('image-dialog').close();
}
function scheduleReads(){clearTimeout(readTimer);readTimer=setTimeout(markReads,200);}
async function markReads(){
 if(document.visibilityState!=='visible'||!document.hasFocus()||$('image-dialog').open||!ready)return;
 const ids=[...visible].filter(id=>{const m=messages.get(id),image=rowCache.get(id)?.node.querySelector('img');return m?.direction==='staff'&&(m.kind==='text'||!m.fileStatus||m.fileStatus==='ready')&&(!image||(image.complete&&image.naturalWidth>0))&&!reported.has(id);});if(!ids.length)return;
 try{await api('/api/read',{ids});for(const id of ids)reported.add(id);}catch{readTimer=setTimeout(markReads,3000);}
}
function connect(){
 clearTimeout(reconnectTimer);reconnectTimer=null;
 if(ws&&(ws.readyState===WebSocket.OPEN||ws.readyState===WebSocket.CONNECTING)){
  if(ws.readyState===WebSocket.OPEN)sync().catch(()=>{});
  return;
 }
 const socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws`);ws=socket;
 socket.onopen=()=>{if(ws!==socket)return;reconnectDelay=1000;connection(true,'已连接 · 请留言咨询');sync().catch(()=>{});};
 socket.onmessage=event=>{if(ws!==socket)return;try{const d=JSON.parse(event.data);if(d.type==='message')put(d.message);if(d.type==='remove'){removeMessage(d.id);render();}}catch{}};
 socket.onclose=()=>{if(ws!==socket)return;ws=null;connection(false,navigator.onLine?'连接恢复中…':'网络已断开，等待恢复');reconnectTimer=setTimeout(()=>{reconnectTimer=null;connect();},reconnectDelay+Math.random()*500);reconnectDelay=Math.min(30000,reconnectDelay*1.7);};
 socket.onerror=()=>{if(ws===socket)socket.close();};
}
async function initialize(){
 const request=++initializationSequence;
 $('loading-state').hidden=false;$('loading-state').classList.remove('failed');$('retry-connect').hidden=true;
 try{
  const getSession=()=>api('/api/session',{});
  const d=navigator.locks?await navigator.locks.request('kf-session',getSession):await getSession();
  if(request!==initializationSequence)return;
  serverOffset=d.serverTime-Date.now();document.title=d.name;$('site-name').textContent=d.name;
  messages.clear();for(const m of d.messages)messages.set(m.id,m);ready=true;input.disabled=false;$('loading-state').hidden=true;render();bottom();updateSend();connect();
 }catch(e){if(request!==initializationSequence)return;connection(false,'暂时无法连接');$('loading-state').classList.add('failed');$('loading-state').querySelector('span:nth-child(2)').textContent=e.message;$('retry-connect').hidden=false;}
}
function attachment(file){if(file&&file.size>MAX){toast('单个附件不能超过 20 MB');$('file-input').value='';return;}selectedFile=file||null;$('attachment-preview').hidden=!file;if(file){$('attachment-name').textContent=file.name;$('attachment-size').textContent=size(file.size);}updateSend();}
function uploadMessage(item){return new Promise((resolve,reject)=>{
 const form=new FormData();form.append('clientId',item.id);form.append('text',item.body);if(item.file)form.append('file',item.file);
 const xhr=new XMLHttpRequest();xhr.open('POST','/api/messages');xhr.timeout=180000;
 xhr.upload.onprogress=e=>{if(e.lengthComputable&&item.file){const n=Math.min(99,Math.round(e.loaded/e.total*100));$('upload-bar').value=n;$('upload-label').textContent=`上传中 ${n}%`;}};
 xhr.onload=()=>{let d;try{d=JSON.parse(xhr.responseText);}catch{reject(new Error('连接异常，请重试'));return;}if(xhr.status>=200&&xhr.status<300)resolve(d.message);else reject(new Error(d.error||'发送失败，请重试'));};
 xhr.onerror=()=>reject(new Error('网络异常，消息尚未确认发送'));xhr.ontimeout=()=>reject(new Error('发送超时，可点击消息重试'));xhr.send(form);
});}
async function send(item){
 if(sending)return;sending=true;item.failed=false;pending.set(item.id,item);render();bottom();updateSend();
 const observedAt=changeSequence;
 if(item.file){$('upload-progress').hidden=false;$('upload-bar').value=0;}
 try{const m=await uploadMessage(item);pending.delete(item.id);put(m,observedAt);}
 catch(e){if(![...messages.values()].some(m=>m.clientId===item.id)){item.failed=true;pending.set(item.id,item);}render();toast(e.message);}
 finally{sending=false;$('upload-progress').hidden=true;updateSend();}
}
function retryPending(id){const item=pending.get(id);if(item)send(item);}
async function retryStored(m,button){button.disabled=true;const observedAt=changeSequence;try{const d=await api(`/api/messages/${m.id}/retry`,{});put(d.message,observedAt);}catch(e){toast(e.message);}finally{button.disabled=false;}}
$('composer').addEventListener('submit',e=>{e.preventDefault();if(!ready||sending||(!input.value.trim()&&!selectedFile))return;const item={id:crypto.randomUUID(),clientId:null,direction:'visitor',kind:'text',body:input.value.trim(),file:selectedFile,filename:selectedFile?.name,size:selectedFile?.size,sentAt:clock(),local:true};input.value='';input.style.height='auto';attachment(null);$('file-input').value='';send(item);});
input.addEventListener('input',()=>{input.style.height='auto';input.style.height=`${Math.min(input.scrollHeight,130)}px`;updateSend();if(document.activeElement===input)bottom();});
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('composer').requestSubmit();}});
$('attach-button').addEventListener('click',()=>$('file-input').click());
$('file-input').addEventListener('change',()=>attachment($('file-input').files[0]));
$('remove-attachment').addEventListener('click',()=>{attachment(null);$('file-input').value='';});
input.addEventListener('paste',e=>{const file=[...e.clipboardData.items].find(i=>i.kind==='file')?.getAsFile();if(file){e.preventDefault();attachment(file);}});
$('retry-connect').addEventListener('click',initialize);
function openImage(m){$('image-dialog').dataset.id=m.id;$('full-image').src=imageSource(m);$('image-dialog').showModal();}
$('close-image').addEventListener('click',()=>$('image-dialog').close());
$('image-dialog').addEventListener('click',e=>{if(e.target===$('image-dialog'))$('image-dialog').close();});
$('image-dialog').addEventListener('close',()=>{$('full-image').removeAttribute('src');scheduleReads();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){sync().catch(()=>{});scheduleReads();}});
window.addEventListener('focus',scheduleReads);
window.addEventListener('online',()=>{if(ready)connect();else initialize();});
setInterval(()=>{if(ready&&document.visibilityState==='visible')sync().catch(()=>{});},30000);
// iOS can pan the visual viewport as well as shrink it for the keyboard.
// Anchor the whole shell to that viewport; only the message list may scroll.
let viewportFrame=0,viewportTimers=[];
function viewport(){
 viewportFrame=0;
 const visual=window.visualViewport;
 // Let browser pinch zoom operate normally instead of relaying out the chat.
 if(visual&&Math.abs(visual.scale-1)>.01)return;
 const followBottom=document.activeElement===input||scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop<48;
 const height=visual?.height||window.innerHeight,top=Math.max(0,visual?.offsetTop||0);
 document.documentElement.style.setProperty('--app-height',`${height}px`);
 document.documentElement.style.setProperty('--app-top',`${top}px`);
 if(followBottom)scroller.scrollTop=scroller.scrollHeight;
 scheduleReads();
}
function scheduleViewport(){if(!viewportFrame)viewportFrame=requestAnimationFrame(viewport);}
function settleViewport(){
 for(const timer of viewportTimers)clearTimeout(timer);
 scheduleViewport();
 // Some Safari versions report their final viewport after the keyboard animation.
 viewportTimers=[80,260,500].map(delay=>setTimeout(scheduleViewport,delay));
}
window.visualViewport?.addEventListener('resize',scheduleViewport);
window.visualViewport?.addEventListener('scroll',scheduleViewport);
window.addEventListener('resize',scheduleViewport);
window.addEventListener('orientationchange',settleViewport);
window.addEventListener('pageshow',settleViewport);
input.addEventListener('focus',settleViewport);
input.addEventListener('blur',settleViewport);
viewport();
if(location.protocol==='https:'||['localhost','127.0.0.1','[::1]'].includes(location.hostname))initialize();
