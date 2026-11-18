import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
setDefaultAutoSelectFamilyAttemptTimeout(1500);
const dir=process.env.DATA_DIR||'/var/lib/kf-chat';
const alerts=[];
let healthy=false;
for(let i=0;i<5;i++){
 try{const r=await fetch('http://127.0.0.1:3000/healthz',{signal:AbortSignal.timeout(5000)});if(r.ok){healthy=true;break;}}catch{}
 if(i<4)await new Promise(r=>setTimeout(r,1500));
}
if(!healthy)alerts.push('客服服务健康检查失败或无法连接');
const disk=fs.statfsSync(dir);const ratio=1-disk.bavail/disk.blocks;
if(ratio>.75)alerts.push(`磁盘使用率 ${Math.round(ratio*100)}%，请清理或扩容`);
try{const db=new Database(path.join(dir,'chat.sqlite'),{readonly:true});const jobs=db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='pending' AND attempts>=5 AND created_at<?").get(Date.now()-600000);if(jobs.n)alerts.push(`${jobs.n} 项消息任务持续重试，请检查 Telegram 连接和权限`);db.close();}catch{alerts.push('客服数据库读取失败');}
const stateFile=path.join(dir,'monitor-state.json');let state={};try{state=JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{}
const text=alerts.join('\n');
if(text&&(state.text!==text||Date.now()-state.at>3600000)){
 const r=await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:process.env.TG_CHAT_ID,text:`【客服系统运行提醒】\n${text}`}),signal:AbortSignal.timeout(20000)});
 const result=await r.json();if(result.ok){fs.writeFileSync(stateFile,JSON.stringify({text,at:Date.now()}),{mode:0o600});}else process.exitCode=1;
}else if(!text&&state.text){
 const r=await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:process.env.TG_CHAT_ID,text:'【客服系统运行提醒】服务已恢复正常。'}),signal:AbortSignal.timeout(20000)});
 const result=await r.json();if(result.ok)fs.writeFileSync(stateFile,JSON.stringify({text:'',at:Date.now()}),{mode:0o600});
}
console.log(alerts.length?`Monitor: ${alerts.length} issue(s)`:'Monitor: OK');
