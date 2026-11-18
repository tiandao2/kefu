// Local-only fixtures: no database, real credentials, Telegram or screenshots.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
import {WebSocketServer} from 'ws';

const publicDir=new URL('../public/',import.meta.url);
let scenario='normal';
const requests=[],timers=new Set();
function delayed(fn){const timer=setTimeout(()=>{timers.delete(timer);fn();},1200);timers.add(timer);}
const server=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://fixture').pathname;
 requests.push({path,cookie:req.headers.cookie||''});
 res.setHeader('Content-Security-Policy',"default-src 'self';script-src 'self';style-src 'self';connect-src 'self';frame-ancestors 'none'");
 if(path==='/healthz'){
  res.setHeader('Content-Type','application/json');
  if(scenario==='timeout-body'){res.write('{');delayed(()=>{if(!res.destroyed)res.end('"ok":true}');});}
  else res.end('{"ok":true}');
  return;
 }
 if(path==='/api/session'||path==='/api/messages'){
  const result=JSON.stringify({name:'在线客服',number:'1',messages:[],serverTime:Date.now(),maxFileSize:20971520,topicReady:true});
  res.setHeader('Content-Type','application/json');
  if(path==='/api/session'&&scenario==='timeout-body'){
   res.write(result.slice(0,1));delayed(()=>{if(!res.destroyed)res.end(result.slice(1));});
  }else if(path==='/api/session'&&scenario==='timeout-headers')delayed(()=>{if(!res.destroyed)res.end(result);});
  else res.end(result);
  return;
 }
 const file=path==='/'?'index.html':path.slice(1);
 if(!['index.html','app.js','style.css','favicon.svg','network-check.html','network-check.js'].includes(file)){res.writeHead(404);res.end();return;}
 try{
  const bytes=await readFile(new URL(file,publicDir));
  res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'image/svg+xml');res.end(bytes);
 }catch{res.writeHead(404);res.end();}
});
const wss=new WebSocketServer({server,path:'/ws'});
wss.on('connection',ws=>ws.send('{"type":"connected"}'));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let passed=0;
try{
 for(const [engineName,engine]of Object.entries({chromium,webkit})){
  const browser=await engine.launch(engineName==='chromium'?{args:['--no-sandbox']}:{});
  try{
   for(const mode of ['normal','legacy-timeout','no-abort-controller','no-fetch','blocked-fetch','timeout-headers','timeout-body']){
    scenario=mode;requests.length=0;
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    await context.addCookies([{name:'kf_session',value:'fixture-cookie',url:base}]);
    await context.addInitScript(mode=>{
     if(mode!=='normal')Object.defineProperty(AbortSignal,'timeout',{configurable:true,value:undefined});
     if(mode==='legacy-timeout'){
      Object.defineProperty(Array.prototype,'at',{configurable:true,value:undefined});
      Object.defineProperty(window,'TextDecoder',{configurable:true,value:undefined});
     }
     if(mode==='no-abort-controller')Object.defineProperty(window,'AbortController',{configurable:true,value:undefined});
     if(mode==='no-fetch')Object.defineProperty(window,'fetch',{configurable:true,value:undefined});
     if(mode==='blocked-fetch')window.fetch=()=>Promise.reject(new TypeError('simulated blocked fetch'));
     if(mode.startsWith('timeout-')){
      const original=window.setTimeout;
      window.setTimeout=(fn,ms,...args)=>original(fn,ms===15000?400:ms,...args);
     }
    },mode);
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    try{
     await page.goto(base+'/network-check.html');await page.locator('#start').click();
     await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('检测完成'));
     const report=JSON.parse(await page.locator('#report').inputValue());
     assert.equal(report.version,3);assert.equal(report.checks.length,12);
     assert.ok(report.brief.includes(report.id)&&report.brief.includes('首字节')&&report.brief.includes('浏览器：'));
     assert.equal(await page.locator('#brief').inputValue(),report.brief);
     if(mode==='normal'){
      await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedReport=text;}}}));
      await page.locator('#copy').click();
      assert.equal(await page.evaluate(()=>window.copiedReport),report.brief);
      assert.ok(report.brief.length<1800);
      await page.locator('details summary').click();await page.locator('#copy-full').click();
      assert.equal(JSON.parse(await page.evaluate(()=>window.copiedReport)).version,3);
     }
     assert.ok(!requests.some(r=>r.path.startsWith('/api/')));
     assert.ok(requests.filter(r=>['/','/app.js','/style.css','/healthz'].includes(r.path)).every(r=>!r.cookie));
     if(mode==='no-fetch'){
      assert.equal(report.capabilities.fetch,false);
      assert.ok(report.checks.every(r=>r.error==='UnsupportedBrowser'&&r.phase==='setup'&&!r.fetchInvoked));
     }else if(mode==='blocked-fetch'){
      assert.ok(report.checks.every(r=>r.error==='TypeError'&&r.errorMessage==='simulated blocked fetch'&&r.phase==='request'&&r.fetchInvoked));
     }else if(mode==='timeout-body'){
      const failed=report.checks.filter(r=>!r.ok);assert.equal(failed.length,3,JSON.stringify(failed));
      assert.ok(failed.every(r=>r.path==='/healthz'&&r.error==='TimeoutError'&&r.phase==='response'));
     }else assert.ok(report.checks.every(r=>r.ok));
     if(mode!=='normal')assert.equal(report.capabilities.abortSignalTimeout,false);
     assert.deepEqual(errors,[]);
     if(!['no-fetch','blocked-fetch'].includes(mode)){
      await page.goto(base+'/');
      if(mode.startsWith('timeout-')){
       await page.waitForFunction(()=>document.getElementById('retry-connect').hidden===false);
       assert.ok((await page.locator('#loading-state').textContent()).includes('请求超时'));
       assert.equal(await page.locator('#message-input').isDisabled(),true);
      }else{
       await page.waitForFunction(()=>document.getElementById('message-input').disabled===false);
       await page.waitForFunction(()=>document.getElementById('connection-label').textContent.startsWith('已连接'));
       assert.ok(requests.some(r=>r.path==='/api/session'&&r.cookie.includes('kf_session=fixture-cookie')));
       await page.waitForFunction(()=>document.getElementById('loading-state').hidden);
      }
      assert.deepEqual(errors,[]);
     }
     passed++;console.log(`${engineName} ${mode}: passed`);
    }finally{await context.close();}
   }
  }finally{await browser.close();}
 }
 console.log(`Compatibility scenarios: ${passed}/14 passed`);
}finally{
 for(const timer of timers)clearTimeout(timer);
 for(const ws of wss.clients)ws.terminate();
 await new Promise(resolve=>wss.close(resolve));
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
