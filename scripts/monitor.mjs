import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { queueHealth } from './queue-health.mjs';
setDefaultAutoSelectFamilyAttemptTimeout(1500);
const dir=process.env.DATA_DIR||'/var/lib/kf-chat';
const stateFile=path.join(dir,'monitor-state.json');let state={};
try{state=JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{}
const alerts=[];let healthy=false,queue=null;
for(let i=0;i<5;i++){
 try{const r=await fetch(`http://127.0.0.1:${Number(process.env.PORT||3000)}/healthz`,{signal:AbortSignal.timeout(5000)});if(r.ok&&(await r.json()).ok===true){healthy=true;break;}}catch{}
 if(i<4)await new Promise(r=>setTimeout(r,1500));
}
if(!healthy)alerts.push('客服服务健康检查失败或无法连接');
try{const disk=fs.statfsSync(dir);const ratio=1-disk.bavail/disk.blocks;if(ratio>.75)alerts.push(`磁盘使用率 ${Math.round(ratio*100)}%，请清理或扩容`);}catch{alerts.push('客服数据磁盘检查失败');}
try{
 const db=new Database(path.join(dir,'chat.sqlite'),{readonly:true});
 try{queue=queueHealth(db,{notifiedFailures:state.notifiedFailures||[]});alerts.push(...queue.alerts);}finally{db.close();}
}catch{alerts.push('客服数据库读取失败');}
const signature=alerts.join('\n'),prior=state.activeIssues??state.text??'';
const repeated=signature&&(signature!==prior||Date.now()-(state.at||0)>=3600000);
const recovery=!signature&&!!prior;
const shouldNotify=repeated||recovery||queue?.newFailureCount;
let delivered=!shouldNotify;
if(shouldNotify){
 const text=['【客服系统运行提醒】',...alerts,queue?.newFailureSummary||'',recovery?'此前监测到的持续异常已解除。':''].filter(Boolean).join('\n');
 try{
  const r=await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:process.env.TG_CHAT_ID,text}),signal:AbortSignal.timeout(20000)});
  delivered=r.ok&&(await r.json()).ok===true;
 }catch{delivered=false;}
 if(!delivered){console.error('Monitor notification failed; notification state was not advanced');process.exitCode=1;}
}
if(delivered){
 const temporary=`${stateFile}.${process.pid}.tmp`;
 const next={activeIssues:signature,at:shouldNotify?Date.now():(state.at||0),notifiedFailures:queue?queue.failureKeys:(state.notifiedFailures||[])};
 try{fs.writeFileSync(temporary,JSON.stringify(next),{mode:0o600});fs.renameSync(temporary,stateFile);}finally{fs.rmSync(temporary,{force:true});}
}
console.log(`Monitor: ${alerts.length} ongoing issue(s), ${queue?.newFailureCount||0} new failure(s), ${queue?.unresolvedFailures||0} unresolved failed task(s); notification ${delivered?'ok':'failed'}`);
