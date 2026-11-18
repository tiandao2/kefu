import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
const project=new URL('../',import.meta.url).pathname.replace(/\/$/,'');
const require=createRequire(path.join(project,'package.json'));
const engines=require('playwright');
const engineName=process.env.KF_BROWSER_ENGINE||'chromium';
const Database=require('better-sqlite3');
const png=await require('sharp')({create:{width:32,height:24,channels:3,background:'#369'}}).png().toBuffer();
const temporary=mkdtempSync(path.join(os.tmpdir(),'kf-current-review-'));
const results={checked_at:new Date().toISOString(),scope:'isolated temporary database, mock Telegram and actual project server; no production requests',checks:[]};
let child,browser,db,seq=1000,topic=100,update=100,logs='';
const calls=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=8000){let start=Date.now();while(Date.now()-start<timeout){const v=await fn();if(v)return v;await delay(50);}throw new Error('Timed out: '+logs.slice(-1000));}
const mock=createServer(async(req,res)=>{
 try{
 if(req.url.startsWith('/file/')){res.setHeader('Content-Type','image/png');res.end(png);return;}
 const chunks=[];for await(const c of req)chunks.push(c);
 const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
 const method=req.url.split('/').pop();calls.push({method,body});
 const result=method==='createForumTopic'?{message_thread_id:++topic,name:body.name}:method==='setMessageReaction'?true:method==='getFile'?{file_path:'fixture.png'}:{message_id:++seq};
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result}));
 }catch(e){res.writeHead(500);res.end('{}');}
});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));
const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const base=`http://127.0.0.1:${port}`;
async function hook(message,edited=false){const r=await fetch(base+'/telegram/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':'review-secret'},body:JSON.stringify({update_id:update++,[edited?'edited_message':'message']:message})});assert.equal(r.status,200);}
const staff=(v,id,text)=>({message_id:id,message_thread_id:v.topic_id,chat:{id:-100123},from:{id:42,is_bot:false},date:Math.floor(Date.now()/1000),text});
async function fixturePage(setup){
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.addInitScript(()=>{const Native=window.WebSocket;window.__testSockets=[];window.WebSocket=class extends Native{constructor(...args){super(...args);window.__testSockets.push(this);}};});
 const page=await context.newPage();if(setup)await setup(page);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.waitForFunction(()=>!document.getElementById('message-input').disabled);
 await page.waitForFunction(()=>document.getElementById('connection-label').textContent.includes('已连接'));
 const cookie=(await context.cookies()).find(c=>c.name==='kf_session');
 const hash=require('node:crypto').createHash('sha256').update(cookie.value).digest('hex');
 const v=await until(()=>{const v=db.prepare('select * from visitors where token_hash=?').get(hash);return v?.topic_id&&v;});
 await until(()=>db.prepare('select count(*) as n from jobs where lane=?').get(`send:${v.id}`).n===0);
 await delay(200);
 return {context,page,v,errors};
}
try{
 child=spawn(process.execPath,['server.mjs'],{cwd:project,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',PUBLIC_ORIGIN:base,ALLOWED_ORIGINS:'',DATA_DIR:temporary,BOT_TOKEN:'review-token',TG_CHAT_ID:'-100123',STAFF_IDS:'42',WEBHOOK_SECRET:'review-secret',TG_API_BASE:`http://127.0.0.1:${mock.address().port}`,GEO_ENABLED:'0',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 await until(async()=>{try{return(await fetch(base+'/healthz')).ok;}catch{return false;}});
 db=new Database(path.join(temporary,'chat.sqlite'));db.pragma('busy_timeout=5000');
 browser=await engines[engineName].launch(engineName==='chromium'?{args:['--no-sandbox']}:{});

 // Model a webview still reporting http: after its transport was upgraded.
 {
 const context=await browser.newContext(),page=await context.newPage();const requests=[];
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());requests.push({url:request.url(),method:request.method()});
  if(url.protocol==='https:'&&url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>HTTPS corrected</title>'});
  const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(['index.html','https-upgrade.js','app.js','style.css','favicon.svg'].includes(name))return route.fulfill({contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html',body:readFileSync(path.join(project,'public',name))});
  return route.fulfill({status:404,body:''});
 });
 await page.goto('http://kf-upgrade.test/');await page.waitForURL('https://kf-upgrade.test/');
 assert.ok(!requests.some(r=>r.url.startsWith('http:')&&(r.url.includes('/api/')||r.url.includes('/ws'))));
 results.checks.push({id:'http_document_upgrades_before_session_requests',passed:true,final_url:page.url()});await context.close();
 }

 // A GET response captured before a revoke arrives after the realtime event.
 {
 const {context,page,v,errors}=await fixturePage();
 await hook(staff(v,2001,'review-revoked-message'));
 await page.getByText('review-revoked-message',{exact:true}).waitFor();
 let release,armed=true,captured=false;
 const gate=new Promise(r=>release=r);
 await page.route('**/api/messages',async route=>{
  if(!armed||route.request().method()!=='GET'){await route.continue();return;}
  armed=false;const response=await route.fetch();const body=await response.text();captured=true;await gate;
  await route.fulfill({status:response.status(),contentType:'application/json',body});
 });
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 await until(()=>captured);
 await hook({...staff(v,2002,'撤回'),reply_to_message:{message_id:2001}});
 await until(async()=>await page.getByText('review-revoked-message',{exact:true}).count()===0);
 release();
 await delay(500);assert.equal(await page.getByText('review-revoked-message',{exact:true}).count(),0);
 const revoked=db.prepare('select revoked from messages where tg_message_id=2001').get().revoked;
 results.checks.push({id:'stale_get_restores_revoked_message',passed:true,server_revoked:revoked,visible_again_after_delayed_get:false,page_errors:errors});
 await context.close();
 }

 // A snapshot must preserve both a newer edit and a message received in flight.
 {
 const {context,page,v}=await fixturePage();
 await hook(staff(v,2003,'snapshot-old-edit'));
 await page.getByText('snapshot-old-edit',{exact:true}).waitFor();
 let release,armed=true,captured=false;
 const gate=new Promise(r=>release=r);
 await page.route('**/api/messages',async route=>{
  if(!armed||route.request().method()!=='GET'){await route.continue();return;}
  armed=false;const response=await route.fetch();const body=await response.text();captured=true;await gate;
  await route.fulfill({status:200,contentType:'application/json',body});
 });
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await until(()=>captured);
 await hook({...staff(v,2003,'snapshot-new-edit'),edit_date:Math.floor(Date.now()/1000)+1},true);
 await hook(staff(v,2004,'new-message-during-snapshot'));
 await page.getByText('snapshot-new-edit',{exact:true}).waitFor();await page.getByText('new-message-during-snapshot',{exact:true}).waitFor();
 release();await delay(400);
 assert.equal(await page.getByText('snapshot-new-edit',{exact:true}).count(),1);assert.equal(await page.getByText('new-message-during-snapshot',{exact:true}).count(),1);
 assert.equal(await page.getByText('snapshot-old-edit',{exact:true}).count(),0);
 results.checks.push({id:'snapshot_preserves_new_edit_and_inflight_message',passed:true});await context.close();
 }

 // The WebSocket keeps its own order, but an independent HTTP snapshot may
 // arrive before older frames. A snapshot watermark also covers unseen ids.
 {
 let pageSocket;const held=[];
 const {context,page,v,errors}=await fixturePage(async page=>{
  await page.routeWebSocket('**/ws',route=>{
   pageSocket=route;const server=route.connectToServer();
   server.onMessage(data=>{const d=JSON.parse(data.toString());if(d.type==='remove'||d.type==='message'&&d.message.body?.startsWith('reverse-'))held.push(data);else route.send(data);});
  });
 });
 async function snapshot(){const response=page.waitForResponse(r=>r.url().endsWith('/api/messages')&&r.request().method()==='GET');await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));const r=await response;await r.finished();await delay(150);return r.json();}
 async function flushAssert(assertion){for(const frame of held.splice(0)){pageSocket.send(frame);await delay(80);await assertion();}}
 await hook(staff(v,2201,'reverse-old-edit'));await until(()=>held.length===1);
 await hook({...staff(v,2201,'reverse-new-edit'),edit_date:Math.floor(Date.now()/1000)+1},true);await until(()=>held.length===2);
 await snapshot();await page.getByText('reverse-new-edit',{exact:true}).waitFor();
 await flushAssert(async()=>{assert.equal(await page.getByText('reverse-new-edit',{exact:true}).count(),1);assert.equal(await page.getByText('reverse-old-edit',{exact:true}).count(),0);});
 results.checks.push({id:'fresh_snapshot_rejects_delayed_realtime_edit',passed:true,page_errors:errors});

 await page.locator('#message-input').fill('reverse-delivery-state');await page.locator('#send-button').click();
 await until(()=>db.prepare("SELECT status FROM messages WHERE visitor_id=? AND body='reverse-delivery-state'").get(v.id)?.status==='sent');
 await snapshot();const delivered=page.locator('.message').filter({hasText:'reverse-delivery-state'});
 await flushAssert(async()=>assert.equal(await delivered.getByText('已发送',{exact:true}).count(),1));
 results.checks.push({id:'fresh_snapshot_rejects_delayed_realtime_queued_status',passed:true});

 await hook({...staff(v,2202,undefined),caption:'reverse-image-version',photo:[{file_id:'reverse-image',width:32,height:24,file_size:png.length}]});
 await until(()=>db.prepare('SELECT file_status FROM messages WHERE visitor_id=? AND tg_message_id=2202').get(v.id)?.file_status==='ready');
 await snapshot();const imageRow=page.locator('.message').filter({hasText:'reverse-image-version'});await imageRow.locator('img').waitFor();
 await flushAssert(async()=>assert.equal(await imageRow.locator('img').count(),1));
 results.checks.push({id:'fresh_snapshot_rejects_delayed_realtime_attachment_placeholder',passed:true});

 await hook(staff(v,2203,'reverse-unseen-revoked'));await until(()=>held.length>0);
 await hook({...staff(v,2204,'撤回'),reply_to_message:{message_id:2203}});
 await until(()=>db.prepare('SELECT revoked FROM messages WHERE visitor_id=? AND tg_message_id=2203').get(v.id)?.revoked===1);
 const current=await snapshot();assert.ok(!current.messages.some(m=>m.body==='reverse-unseen-revoked'));
 await flushAssert(async()=>assert.equal(await page.getByText('reverse-unseen-revoked',{exact:true}).count(),0));
 results.checks.push({id:'snapshot_watermark_rejects_unseen_message_revoked_before_snapshot',passed:true});
 await context.close();
 }

 // A queued POST response must not overwrite the newer delivered event.
 {
 const {context,page,errors}=await fixturePage();
 let release,captured=false,armed=true,snapshot;
 const gate=new Promise(r=>release=r);
 await page.route('**/api/messages',async route=>{
  if(!armed||route.request().method()!=='POST'){await route.continue();return;}
  armed=false;const response=await route.fetch();const body=await response.text();snapshot=JSON.parse(body);captured=true;await gate;
  await route.fulfill({status:response.status(),contentType:'application/json',body});
 });
 await page.locator('#message-input').fill('review-delivery-regression');await page.locator('#send-button').click();
 await until(()=>captured);assert.equal(snapshot.message.status,'queued');
 const row=page.locator('.message').filter({hasText:'review-delivery-regression'});
 await until(async()=>await row.getByText('已发送',{exact:true}).count()===1);
 release();await delay(500);assert.equal(await row.getByText('已发送',{exact:true}).count(),1);
 const status=db.prepare('select status from messages where id=?').get(snapshot.message.id).status;
 results.checks.push({id:'stale_post_rolls_back_delivered_status',passed:true,server_status:status,late_response_status:snapshot.message.status,visible_status:'已发送',page_errors:errors});
 await context.close();
 }

 // Replacing an open WebSocket schedules another replacement on every close.
 {
 const {context,page,errors}=await fixturePage();
 let opened=0;page.on('websocket',()=>opened++);
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await delay(5200);
 results.checks.push({id:'online_event_causes_reconnect_loop',passed:opened<=1,online_events_dispatched:1,new_websockets_in_5200ms:opened,expected_new_websockets:1,page_errors:errors});
 assert.ok(opened<=1,'A single online event must not cause a reconnect loop');
 const before=opened;
 await page.evaluate(()=>{window.__oldSocket=window.__testSockets[0];window.__oldSocket.close();});
 await until(()=>opened===before+1);await page.waitForFunction(()=>document.getElementById('connection-label').textContent.includes('已连接'));
 await page.evaluate(()=>{window.__oldSocket.onclose?.(new CloseEvent('close'));window.__oldSocket.onerror?.(new Event('error'));for(let i=0;i<3;i++)window.dispatchEvent(new Event('online'));});
 await delay(1800);assert.equal(opened,before+1);assert.ok((await page.locator('#connection-label').textContent()).includes('已连接'));
 results.checks.push({id:'late_old_socket_callbacks_and_repeated_online_are_ignored',passed:true});
 await context.close();
 }

 // Durable work resumes after an outage longer than its advertised time window.
 {
 const {context,v}=await fixturePage();
 const id=randomUUID(),old=Date.now()-25*3600000;
 db.transaction(()=>{
 db.prepare("insert into messages(id,visitor_id,client_id,direction,kind,body,sent_at,status) values(?,?,?,'visitor','text',?,?,'queued')").run(id,v.id,'review-expired-client','review-expired-25h',old);
 db.prepare("insert into jobs(kind,payload,dedup,attempts,available_at,created_at,state,lane,category) values('outgoing',?,?,0,0,?,'pending',?,'send')").run(JSON.stringify({messageId:id}),`outgoing:${id}`,old,`send:${v.id}`);
 })();
 await until(()=>db.prepare('select status from messages where id=?').get(id).status==='failed');
 assert.ok(!calls.some(c=>c.method==='sendMessage'&&c.body.text==='review-expired-25h'));
 results.checks.push({id:'expired_task_is_still_delivered',passed:true,message_age_hours:25,result_status:'failed',delivery_target:'local mock Telegram only'});
 await context.close();
 }

 // A file ready on the server is not yet a decoded image in the browser.
 {
 const {context,page,v}=await fixturePage();
 await page.evaluate(()=>Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>true}));
 let release,captured=false;const gate=new Promise(r=>release=r);
 await page.route('**/api/files/**',async route=>{captured=true;await gate;await route.continue();});
 await hook({...staff(v,2010,undefined),photo:[{file_id:'media-image',width:32,height:24,file_size:png.length}]});
 await until(()=>captured);await delay(700);
 const premature=calls.some(c=>c.method==='setMessageReaction'&&c.body.message_id===2010);
 release();assert.equal(premature,false,'A blocked image must remain unread until it actually loads');
 await until(()=>calls.some(c=>c.method==='setMessageReaction'&&c.body.message_id===2010));
 const row=page.locator('.message').filter({has:page.locator('img')});
 await row.locator('img').click();const previous=await page.locator('#full-image').getAttribute('src');
 await hook({...staff(v,2010,undefined),caption:'new-image-caption',photo:[{file_id:'media-image',width:32,height:24,file_size:png.length}],edit_date:Math.floor(Date.now()/1000)+1},true);
 await page.getByText('new-image-caption',{exact:true}).waitFor();await delay(200);
 assert.notEqual(await page.locator('#full-image').getAttribute('src'),previous,'An open preview must follow the edited message version');
 results.checks.push({id:'image_reads_wait_for_decode_and_preview_follows_edit',passed:true});await context.close();
 }
 results.passed=true;results.engine=engineName;
}catch(e){results.error=e.stack;results.passed=false;process.exitCode=1;}
finally{
 await browser?.close();db?.close();
 if(child&&child.exitCode===null){const ended=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await Promise.race([ended,delay(12000)]);if(child.exitCode===null)child.kill('SIGKILL');}
 mock.closeAllConnections();await new Promise(r=>mock.close(r));
 rmSync(temporary,{recursive:true,force:true});
 if(process.env.KF_REGRESSION_OUTPUT)writeFileSync(process.env.KF_REGRESSION_OUTPUT,JSON.stringify(results,null,2)+'\n');
 console.log(JSON.stringify(results,null,2));
}
