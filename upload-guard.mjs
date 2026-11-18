import fs from 'node:fs';
import path from 'node:path';
import {createHmac,randomUUID} from 'node:crypto';
import {isIP} from 'node:net';

const MiB=1024*1024,DAY=86400000;
export const UPLOAD_DEFAULTS=Object.freeze({visitorDailyBytes:100*MiB,ipDailyBytes:500*MiB,visitorDailyFiles:200,ipDailyFiles:1000,totalBytes:20*1024*MiB,minFreeBytes:2*1024*MiB,maxConcurrent:4,maxPerVisitor:3,maxPerIp:4});
export function uploadLimits(env=process.env){
 const values={};
 for(const [key,name]of Object.entries({visitorDailyBytes:'UPLOAD_VISITOR_DAILY_BYTES',ipDailyBytes:'UPLOAD_IP_DAILY_BYTES',visitorDailyFiles:'UPLOAD_VISITOR_DAILY_FILES',ipDailyFiles:'UPLOAD_IP_DAILY_FILES',totalBytes:'UPLOAD_TOTAL_BYTES',minFreeBytes:'UPLOAD_MIN_FREE_BYTES',maxConcurrent:'UPLOAD_CONCURRENT',maxPerVisitor:'UPLOAD_CONCURRENT_VISITOR',maxPerIp:'UPLOAD_CONCURRENT_IP'})){
  const n=env[name]===undefined?UPLOAD_DEFAULTS[key]:Number(env[name]);
  if(!Number.isSafeInteger(n)||n<(key==='minFreeBytes'?0:1))throw new Error(`Invalid ${name}`);
  values[key]=n;
 }
 return values;
}
function error(message,status=429,retryAfter=60){return Object.assign(new Error(message),{code:'UPLOAD_LIMIT',status,retryAfter});}
function canonicalAddress(value){
 let ip=String(value||'');
 if(/^::ffff:/i.test(ip)){
  const tail=ip.slice(7);
  if(isIP(tail)===4)ip=tail;
  else if(/^[a-f\d]{1,4}:[a-f\d]{1,4}$/i.test(tail)){const a=tail.split(':').map(n=>parseInt(n,16));ip=[a[0]>>>8,a[0]&255,a[1]>>>8,a[1]&255].join('.');}
 }
 if(isIP(ip)===6)return new URL(`http://[${ip}]/`).hostname;
 return isIP(ip)===4?ip:'unknown';
}
function directoryBytes(dir){
 let size=0;
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const p=path.join(dir,entry.name);
  try{if(entry.isDirectory())size+=directoryBytes(p);else if(entry.isFile())size+=fs.statSync(p).size;}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 return size;
}
// Admission is synchronous in the single app process. Byte reservations are
// persisted before file data is written, so parallel requests and restarts
// cannot spend the same rolling allowance twice.
export function createUploadGuard({db,directory,secret,limits=UPLOAD_DEFAULTS,now=Date.now,usage=()=>directoryBytes(directory),freeBytes=()=>{const s=fs.statfsSync(directory);return s.bavail*s.bsize;}}){
 db.exec(`CREATE TABLE IF NOT EXISTS upload_usage(id TEXT PRIMARY KEY,visitor_id TEXT NOT NULL,ip_key TEXT NOT NULL,created_at INTEGER NOT NULL,bytes INTEGER NOT NULL CHECK(bytes>=0));
  CREATE INDEX IF NOT EXISTS upload_usage_visitor ON upload_usage(visitor_id,created_at);
  CREATE INDEX IF NOT EXISTS upload_usage_ip ON upload_usage(ip_key,created_at);
  CREATE INDEX IF NOT EXISTS upload_usage_time ON upload_usage(created_at);`);
 const active=new Map();let reservedStorage=0,knownBytes=0,lastScan=-Infinity;
 const ipKey=ip=>createHmac('sha256',secret).update(canonicalAddress(ip)).digest('hex');
 const prune=()=>db.prepare('DELETE FROM upload_usage WHERE created_at<=?').run(now()-DAY);
 const reserveQuota=db.transaction((id,visitorId,key,bytes)=>{
  prune();const cutoff=now()-DAY;
  const visitor=db.prepare('SELECT coalesce(sum(bytes),0) AS bytes,count(*) AS files FROM upload_usage WHERE visitor_id=? AND created_at>?').get(visitorId,cutoff);
  const ip=db.prepare('SELECT coalesce(sum(bytes),0) AS bytes,count(*) AS files FROM upload_usage WHERE ip_key=? AND created_at>?').get(key,cutoff);
  if(visitor.bytes+bytes>limits.visitorDailyBytes||visitor.files>=limits.visitorDailyFiles)throw error('今日附件上传额度已用完，请稍后再试',429,3600);
  if(ip.bytes+bytes>limits.ipDailyBytes||ip.files>=limits.ipDailyFiles)throw error('当前网络附件上传额度已用完，请稍后再试',429,3600);
  db.prepare('INSERT INTO upload_usage VALUES(?,?,?,?,?)').run(id,visitorId,key,now(),bytes);
 });
 function reserveStorage(bytes){
  if(!Number.isSafeInteger(bytes)||bytes<0)throw new Error('Invalid storage reservation');
  if(now()-lastScan>=5000){knownBytes=usage();lastScan=now();}
  // Include all outstanding writes, even if a scan already counted their
  // partial files. Conservative overcount is reconciled at the next scan.
  if(knownBytes+reservedStorage+bytes>limits.totalBytes||freeBytes()-reservedStorage-bytes<limits.minFreeBytes)throw error('附件空间暂时不足，请稍后再试',503,60);
  reservedStorage+=bytes;let released=false;
  return (written=bytes)=>{if(released)return;released=true;reservedStorage-=bytes;knownBytes+=Math.max(0,Math.min(bytes,written));};
 }
 function begin(visitorId,ip){
  const key=ipKey(ip),values=[...active.values()];
  if(active.size>=limits.maxConcurrent||values.filter(v=>v.visitorId===visitorId).length>=limits.maxPerVisitor||values.filter(v=>v.key===key).length>=limits.maxPerIp)throw error('同时上传的请求过多，请稍后再试');
  const id=randomUUID();let charged=0,reserved=0,started=false,finished=false,releaseStorage;
  active.set(id,{visitorId,key});
  return {
   startFile(bytes){
    if(started)throw error('每次只能上传一个附件',400);
    if(!Number.isSafeInteger(bytes)||bytes<=0)throw new Error('Invalid upload reservation');
    releaseStorage=reserveStorage(bytes);
    try{reserveQuota.immediate(id,visitorId,key,bytes);}catch(e){releaseStorage(0);releaseStorage=null;throw e;}
    reserved=bytes;started=true;
   },
   record(bytes){charged=Math.min(reserved,charged+bytes);},
   finish(){
    if(finished)return;finished=true;
    try{if(started)db.prepare('UPDATE upload_usage SET bytes=? WHERE id=?').run(charged,id);}finally{releaseStorage?.(charged);active.delete(id);}
   }
  };
 }
 return {begin,reserveStorage,prune};
}
