import {chromium,webkit} from 'playwright';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import sharp from 'sharp';
const dir=mkdtempSync(path.join(tmpdir(),'kf-browser-')),base='http://127.0.0.1:15311';
const engineName=process.env.KF_BROWSER_ENGINE||'chromium';
const screenshotDir=process.env.KF_SCREENSHOT_DIR||'/root/workspace-b/codex-outputs';mkdirSync(screenshotDir,{recursive:true});
assert.ok(['chromium','webkit'].includes(engineName));
let seq=100,topic=100,update=1,child,browser,db;
const calls=[],errors=[];
const failTexts=new Set();
const deletedTopics=new Set();
const png=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#edf4ee"/><circle cx="470" cy="130" r="50" fill="#ead7a8"/><path d="M0 390 190 170 390 400 530 250 640 370V480H0Z" fill="#719a86"/><path d="M0 440 260 300 470 480H0Z" fill="#3b7561"/><text x="40" y="75" font-size="28" fill="#315e4d">PHOTO PREVIEW</text></svg>')).png().toBuffer();
const jpeg=await sharp(png).resize(320,240).jpeg().toBuffer();
const mock=createServer(async(req,res)=>{
 if(req.url.startsWith('/file/')){res.setHeader('Content-Type','image/jpeg');res.end(req.url.includes('heic-file')?readFileSync(new URL('../test/fixtures/solid.heic',import.meta.url)):jpeg);return;}
 const chunks=[];for await(const c of req)chunks.push(c);const bytes=Buffer.concat(chunks);let d={};
 if(req.headers['content-type']?.includes('multipart/form-data')){const form=await new Request('http://localhost'+req.url,{method:'POST',headers:req.headers,body:bytes}).formData();for(const [k,v]of form)d[k]=typeof v==='string'?v:{name:v.name,bytes:Buffer.from(await v.arrayBuffer())};}
 else if(bytes.length)d=JSON.parse(bytes);
 const method=req.url.split('/').pop();const call={method,body:d};calls.push(call);res.setHeader('Content-Type','application/json');
 if(method==='sendMessage'&&failTexts.delete(d.text)){call.failed=true;res.end(JSON.stringify({ok:false,error_code:400,description:'Bad Request: simulated permanent failure'}));return;}
 if(deletedTopics.has(d.message_thread_id)){call.failed=true;res.end(JSON.stringify({ok:false,error_code:400,description:'Bad Request: message thread not found'}));return;}
 res.end(JSON.stringify({ok:true,result:method==='createForumTopic'?{message_thread_id:++topic}:method==='getFile'?{file_path:d.file_id+'.jpg'}:method==='setMessageReaction'?true:method==='sendPhoto'?{message_id:++seq,photo:[{file_id:'uploaded-largest',width:1280,height:960},{file_id:'uploaded-small',width:90,height:90}]}:{message_id:++seq}}));
});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<150;i++){if(await fn())return;await wait(100);}throw new Error('Browser check timed out');}
async function hook(message,edited=false){const r=await fetch(base+'/telegram/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':'browser-secret'},body:JSON.stringify({update_id:update++,[edited?'edited_message':'message']:message})});assert.ok(r.ok);}
try{
 await new Promise(r=>mock.listen(15312,'127.0.0.1',r));
 child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'15311',HOST:'127.0.0.1',PUBLIC_ORIGIN:base,BOT_TOKEN:'browser-token',TG_CHAT_ID:'-100123',STAFF_IDS:'42',WEBHOOK_SECRET:'browser-secret',DATA_DIR:dir,TG_API_BASE:'http://127.0.0.1:15312',GEO_ENABLED:'0'},stdio:'pipe'});
 child.stderr.on('data',d=>process.stderr.write(d));
 await until(async()=>{try{return(await fetch(base+'/healthz')).ok;}catch{return false;}});
 db=new Database(path.join(dir,'chat.sqlite'));
 browser=await (engineName==='webkit'?webkit:chromium).launch(engineName==='chromium'?{args:['--no-sandbox']}:{});
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2});
 const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);if(process.env.KF_BROWSER_DEBUG)console.error('Page error',e.stack||e.message);});
 if(process.env.KF_BROWSER_DEBUG){page.on('requestfailed',r=>console.error('Request failed',r.method(),r.url(),r.failure()?.errorText));page.on('console',m=>{if(m.type()==='error')console.error('Browser console',m.text());});}
 await page.goto(base);await page.waitForFunction(()=>!document.getElementById('message-input').disabled);
 assert.equal(await page.locator('.message').count(),1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.equal(await page.locator('#visitor-number,.message-avatar,#download-image').count(),0);
 assert.equal(await page.getByText('仅展示最近 24 小时记录',{exact:true}).count(),0);
 assert.equal(await page.locator('.context-bar').count(),0);
 const header=await page.locator('.header').boundingBox();assert.ok(header.height<=60,'header must be compact');
 const privateTag=await page.locator('.private-tag').boundingBox(),serviceNote=await page.locator('.service-note').boundingBox();assert.ok(serviceNote.y>=privateTag.y+privateTag.height,'service note must be below private-session label');
 await page.locator('#message-input').fill('浏览器发送测试');await page.locator('#send-button').click();
 await until(()=>calls.some(c=>c.body.text==='浏览器发送测试'));
 const v=db.prepare('SELECT * FROM visitors LIMIT 1').get();
 await page.evaluate(()=>Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}));
 const m={message_id:501,message_thread_id:v.topic_id,chat:{id:-100123},from:{id:42,is_bot:false},date:Math.floor(Date.now()/1000),text:'浏览器后台已读测试'};
 await hook(m);await page.waitForSelector('.message[data-id]');await until(async()=>await page.getByText(m.text,{exact:true}).count()===1);await wait(700);
 assert.equal(calls.filter(c=>c.method==='setMessageReaction').length,0,'background page must not report read');
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
 await until(()=>calls.some(c=>c.method==='setMessageReaction'&&c.body.message_id===501));
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await wait(700);assert.equal(calls.filter(c=>c.method==='setMessageReaction'&&c.body.message_id===501).length,1);assert.ok(!calls.some(c=>c.body.text==='已读'));
 await hook({...m,text:'浏览器编辑同步测试',edit_date:Math.floor(Date.now()/1000)},true);
 await until(async()=>await page.getByText('浏览器编辑同步测试',{exact:true}).count()===1);
 await hook({...m,message_id:502,text:'撤回',reply_to_message:{message_id:501}});
 await until(async()=>await page.getByText('浏览器编辑同步测试',{exact:true}).count()===0);
 assert.equal(await page.getByText('对方撤回了一条消息').count(),0);
 // Restore native visibility before navigation; a forced-visible old document
 // would otherwise attempt a fetch while WebKit is destroying that document.
 await page.evaluate(()=>{delete document.visibilityState;delete document.hasFocus;});
 await page.reload();await page.waitForFunction(()=>!document.getElementById('message-input').disabled);assert.equal(await page.getByText('浏览器编辑同步测试').count(),0);
 const initialTopics=calls.filter(c=>c.method==='createForumTopic').length;await page.reload();await page.waitForFunction(()=>!document.getElementById('message-input').disabled);assert.equal(calls.filter(c=>c.method==='createForumTopic').length,initialTopics);
 const photo={...m,message_id:503,text:undefined,caption:'客服直接发图测试',photo:[{file_id:'browser-photo-large',width:1280,height:960},{file_id:'browser-photo-small',width:90,height:90}]};
 await hook(photo);
 await until(async()=>await page.getByText('客服直接发图测试',{exact:true}).count()===1);
 const photoRow=page.locator('.message').filter({hasText:'客服直接发图测试'});
 await photoRow.locator('img').waitFor();await until(async()=>photoRow.locator('img').evaluate(e=>e.complete&&e.naturalWidth>0));
 assert.equal(await photoRow.locator('a').count(),0);
 assert.ok(calls.some(c=>c.method==='getFile'&&c.body.file_id==='browser-photo-large'));
 await photoRow.locator('img').click();assert.ok(await page.locator('#image-dialog').evaluate(e=>e.open));assert.equal(await page.locator('#image-dialog a').count(),0);await page.locator('#close-image').click();
 await hook({...photo,caption:'客服照片编辑测试',photo:[{file_id:'browser-photo-edited',width:1600,height:1200}],edit_date:Math.floor(Date.now()/1000)},true);
 await until(async()=>await page.getByText('客服照片编辑测试',{exact:true}).count()===1);
 await hook({...m,message_id:504,text:'撤回',reply_to_message:{message_id:503}});
 await until(async()=>await page.getByText('客服照片编辑测试',{exact:true}).count()===0);
 deletedTopics.add(v.topic_id);
 await page.locator('#message-input').fill('话题删除后浏览器发消息');await page.locator('#send-button').click();
 await until(async()=>await page.locator('.message').filter({hasText:'话题删除后浏览器发消息'}).getByText('已发送',{exact:true}).count()===1);
 assert.equal(calls.filter(c=>c.method==='createForumTopic').length,initialTopics+1);
 v.topic_id=db.prepare('SELECT topic_id FROM visitors WHERE id=?').get(v.id).topic_id;
 await page.locator('#file-input').setInputFiles({name:'客户照片.png',mimeType:'image/png',buffer:png});
 assert.ok(!(await page.locator('#attachment-size').textContent()).includes('原文件'));
 await page.locator('#send-button').click();
 await until(()=>calls.some(c=>c.method==='sendPhoto'));
 await until(()=>db.prepare("SELECT status FROM messages WHERE filename='客户照片.jpg'").get()?.status==='sent');
 assert.deepEqual(calls.find(c=>c.method==='sendPhoto').body.photo.bytes,png);
 const ownPhoto=page.locator('.message.own').filter({has:page.locator('img')});
 await until(async()=>await ownPhoto.count()===1);assert.equal(await ownPhoto.locator('a').count(),0);
 await ownPhoto.locator('img').click();assert.equal(await page.locator('#image-dialog a').count(),0);await page.locator('#close-image').click();
 // Explicit terminal failure is visible and retry reuses the same message.
 failTexts.add('浏览器失败重试测试');
 await page.locator('#message-input').fill('浏览器失败重试测试');await page.locator('#send-button').click();
 const failed=page.locator('.message.own').filter({hasText:'浏览器失败重试测试'});
 await failed.getByRole('button',{name:'重试发送',exact:true}).waitFor();
 await failed.getByRole('button',{name:'重试发送',exact:true}).click();
 await until(async()=>await failed.getByText('已发送',{exact:true}).count()===1);
 assert.equal(await failed.count(),1);assert.equal(calls.filter(c=>c.body.text==='浏览器失败重试测试'&&!c.failed).length,1);
 // A staff original HEIC has a JPEG preview, with no image download button.
 await hook({...m,message_thread_id:v.topic_id,message_id:505,text:undefined,caption:'HEIC原文件预览测试',document:{file_id:'heic-file',file_name:'iphone.heic',mime_type:'image/heic',file_size:391}});
 const heicRow=page.locator('.message').filter({hasText:'HEIC原文件预览测试'});
 await heicRow.locator('img').waitFor();await until(async()=>heicRow.locator('img').evaluate(e=>e.complete&&e.naturalWidth===96));
 assert.equal(await heicRow.locator('a').count(),0);await heicRow.locator('img').click();
 await until(async()=>page.locator('#full-image').evaluate(e=>e.complete&&e.naturalWidth===96));assert.equal(await page.locator('#image-dialog a').count(),0);await page.locator('#close-image').click();
 for(let i=0;i<8;i++)await hook({...m,message_thread_id:v.topic_id,message_id:600+i,text:`长消息滚动测试 ${i}。`.repeat(15)});
 await until(async()=>await page.getByText(/^长消息滚动测试 7/).count()===1);await wait(500);
 assert.ok(await page.locator('#messages').evaluate(e=>e.scrollHeight-e.clientHeight-e.scrollTop<5),'new messages must scroll to bottom');
 await hook({...m,message_thread_id:v.topic_id,message_id:700,date:Math.floor(Date.now()/1000),text:'输入时仍可看到这条客服回复'});
 await until(async()=>await page.getByText('输入时仍可看到这条客服回复',{exact:true}).count()===1);
 // Model both keyboard resizing and Safari's independent visual viewport pan.
 await page.evaluate(()=>{
  window.__keyboardViewport={height:innerHeight,offsetTop:0,scale:1};
  for(const key of ['height','offsetTop','scale'])Object.defineProperty(visualViewport,key,{configurable:true,get:()=>window.__keyboardViewport[key]});
 });
 async function visualViewport(height,offsetTop=0,scale=1){
  await page.evaluate(values=>{Object.assign(window.__keyboardViewport,values);window.visualViewport.dispatchEvent(new Event('resize'));window.visualViewport.dispatchEvent(new Event('scroll'));},{height,offsetTop,scale});
  if(scale===1)await until(async()=>page.evaluate(expected=>document.documentElement.style.getPropertyValue('--app-height')===`${expected.height}px`&&document.documentElement.style.getPropertyValue('--app-top')===`${expected.offsetTop}px`,{height,offsetTop}));
 }
 async function assertKeyboardLayout(height,offsetTop=0){
  const layout=await page.evaluate(()=>{
   const box=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};};
   return {shell:box('.chat-shell'),header:box('.header'),messages:box('#messages'),input:box('#message-input'),composer:box('.composer-wrap'),scrollY,overflow:document.documentElement.scrollWidth>innerWidth};
  });
  assert.ok(Math.abs(layout.shell.top-offsetTop)<2);assert.ok(Math.abs(layout.shell.height-height)<2);
  assert.ok(layout.input.top>=offsetTop&&layout.input.bottom<=offsetTop+height,'input stays inside visible viewport');
  assert.ok(layout.messages.height>40,'conversation retains visible space');assert.ok(layout.messages.top>=layout.header.bottom-1);assert.ok(layout.messages.bottom<=layout.composer.top+1);
  assert.equal(layout.scrollY,0,'outer document must not scroll');assert.equal(layout.overflow,false);
 }
 await page.locator('#message-input').focus();
 await visualViewport(400);await assertKeyboardLayout(400);
 await visualViewport(400,160);await assertKeyboardLayout(400,160);
 await page.locator('#message-input').fill('键盘展开后输入第一行\n第二行\n第三行');await assertKeyboardLayout(400,160);
 await until(async()=>page.locator('#messages').evaluate(e=>e.scrollHeight-e.clientHeight-e.scrollTop<5));
 const staffBox=await page.getByText('输入时仍可看到这条客服回复',{exact:true}).boundingBox(),messagesBox=await page.locator('#messages').boundingBox();assert.ok(staffBox.y>=messagesBox.y&&staffBox.y+staffBox.height<=messagesBox.y+messagesBox.height,'latest staff response remains visible while typing');
 if(engineName==='chromium')await page.screenshot({path:path.join(screenshotDir,'customer-keyboard-viewport.png'),clip:{x:0,y:160,width:390,height:400}});
 await page.locator('#message-input').fill('键盘可见时发送测试');await page.locator('#send-button').click();
 await until(()=>calls.some(c=>c.body.text==='键盘可见时发送测试'&&!c.failed));await assertKeyboardLayout(400,160);
 await page.locator('#message-input').blur();await visualViewport(844);await assertKeyboardLayout(844);
 await page.locator('#messages').evaluate(e=>e.scrollTop=0);await visualViewport(820);assert.equal(await page.locator('#messages').evaluate(e=>e.scrollTop),0,'viewport changes preserve reading position when not typing');
 await visualViewport(300,80,1.5);await wait(100);assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--app-height')),'820px','pinch zoom must not resize the shell');
 await visualViewport(844);
 await page.setViewportSize({width:844,height:390});await visualViewport(390);await page.locator('#message-input').focus();await visualViewport(240,30);await assertKeyboardLayout(240,30);
 assert.equal(await page.locator('#message-input').evaluate(e=>getComputedStyle(e).fontSize),'16px');
 await page.locator('#message-input').blur();await page.setViewportSize({width:320,height:568});await visualViewport(568);await assertKeyboardLayout(568);
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>{for(const key of ['height','offsetTop','scale'])delete visualViewport[key];delete window.__keyboardViewport;visualViewport.dispatchEvent(new Event('resize'));});
 await until(async()=>page.evaluate(()=>Math.abs(document.querySelector('.chat-shell').getBoundingClientRect().height-visualViewport.height)<2));
 await page.locator('#messages').evaluate(e=>e.scrollTop=e.scrollHeight);await wait(150);
 if(engineName==='chromium')await page.screenshot({path:path.join(screenshotDir,'customer-compact-mobile.png'),fullPage:true});
 await page.setViewportSize({width:1280,height:900});await wait(150);
 if(engineName==='chromium')await page.screenshot({path:path.join(screenshotDir,'customer-compact-desktop.png'),fullPage:true});
 assert.equal(await page.locator('.message-avatar,#visitor-number,#download-image').count(),0);
 assert.deepEqual(errors,[]);
 console.log(`${engineName} browser checks passed: compact header (${header.height}px), relocated service note, keyboard resize/pan, multiline typing/sending, keyboard dismissal, preserved reading position, pinch zoom, landscape and 320px layouts; photo uploads/preview/edit/revoke, thumbs-up receipts and deleted-topic recovery.`);
}finally{
 await browser?.close();db?.close();if(child){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}await new Promise(r=>mock.close(r));rmSync(dir,{recursive:true,force:true});
}
