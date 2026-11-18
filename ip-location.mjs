import {BlockList,isIP} from 'node:net';
const UNKNOWN='未知地区',SOURCE='https://ip.cn';
const privateNetworks=new BlockList();
for(const [ip,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])privateNetworks.addSubnet(ip,prefix,'ipv4');
for(const [ip,prefix] of [['::',96],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32],['2001:2::',48]])privateNetworks.addSubnet(ip,prefix,'ipv6');
function canonicalIp(value){
 if(typeof value!=='string')return null;
 const family=isIP(value);
 if(!family||value.includes('%'))return null;
 return family===6?new URL(`http://[${value}]/`).hostname.slice(1,-1):value;
}
export function normalizePublicIp(value){
 let ip=typeof value==='string'?value.trim():'';
 if(/^::ffff:/i.test(ip)){
  const tail=ip.slice(7);
  if(isIP(tail)===4)ip=tail;
  else if(/^[a-f\d]{1,4}:[a-f\d]{1,4}$/i.test(tail)){
   const n=tail.split(':').map(x=>parseInt(x,16));ip=[n[0]>>>8,n[0]&255,n[1]>>>8,n[1]&255].join('.');
  }
 }
 const family=isIP(ip);if(!family||ip.includes('%')||privateNetworks.check(ip,family===4?'ipv4':'ipv6'))return null;
 // Only global IPv6 unicast; reject unspecified, loopback and scoped addresses.
 if(family===6&&!/^[23][a-f\d]{0,3}:/i.test(ip))return null;
 return canonicalIp(ip);
}
function text(value){
 return value.replace(/<[^>]*>/g,'').replace(/&#(x[a-f\d]+|\d+);/gi,(_,n)=>{const code=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return code>0&&code<=0x10ffff?String.fromCodePoint(code):'';}).replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/[\u0000-\u001f\u007f]/g,'').trim();
}
export function parseIpCnPage(html,requestedIp){
 const rows=[...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];let echoed='',region='';
 for(const [,row]of rows){
  const label=text(row.match(/<th\b[^>]*>([\s\S]*?)<\/th>/i)?.[1]||'');
  const cell=row.match(/<td\b[^>]*>([\s\S]*?)<\/td>/i)?.[1]||'';
  const value=text(cell.match(/<span\b[^>]*>([\s\S]*?)<\/span>/i)?.[1]||'');
  if(label==='您查询的IP')echoed=value.toLowerCase();
  if(label==='所在地理位置')region=value;
 }
 if(!canonicalIp(requestedIp)||canonicalIp(echoed)!==canonicalIp(requestedIp)||!region||/未知|无法|查询失败|验证码|请核实/.test(region))return UNKNOWN;
 return region.replace(/^中国(?:\s+|$)/,'').replace(/\s+/g,'').slice(0,64)||UNKNOWN;
}
export function parseIpWhoIsResponse(body,requestedIp){
 let data;try{data=JSON.parse(body);}catch{return UNKNOWN;}
 if(!data||data.success!==true||!canonicalIp(requestedIp)||canonicalIp(data.ip)!==canonicalIp(requestedIp))return UNKNOWN;
 const chinese=value=>/\p{Script=Han}/u.test(value)&&!/[a-z]/i.test(value);
 if(typeof data.country!=='string'||!chinese(text(data.country)))return UNKNOWN;
 const parts=[data.country,data.region??'',data.city??''];
 if(parts.some(x=>typeof x!=='string'))return UNKNOWN;
 // Some rare locations lack a translation even with lang=zh-CN. Keep only
 // Chinese name components instead of presenting an English location.
 const region=parts.map(text).filter(chinese).join(' ');
 if(!region||/未知|无法|查询失败|验证码|请核实/.test(region))return UNKNOWN;
 return region.replace(/^中国(?:\s+|$)/,'').replace(/\s+/g,'').slice(0,64)||UNKNOWN;
}
async function responseBody(response){
 if(response.status!==200){await response.body?.cancel();throw new Error('Invalid location response');}
 const reader=response.body.getReader(),chunks=[];let bytes=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>256000)throw new Error('Location response too large');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
 return Buffer.concat(chunks).toString('utf8');
}
export function createIpCnLookup({enabled=true,fetchImpl=fetch,timeoutMs=2000,cacheMs=86400000,maxEntries=512,maxConcurrent=2,maxPending=128,now=Date.now}={}){
 const cache=new Map(),pending=new Map(),waiting=[];let active=0,secondaryUntil=0;
 const acquire=()=>active<maxConcurrent?(active++,Promise.resolve()):new Promise(resolve=>waiting.push(resolve));
 const release=()=>{const next=waiting.shift();if(next)next();else active--;};
 return async value=>{
  const ip=normalizePublicIp(value);if(!enabled||!ip)return UNKNOWN;
  const saved=cache.get(ip);if(saved&&saved.until>now())return saved.region;
  if(pending.has(ip))return pending.get(ip);
  // Bounded waiting replaces the old immediate "unknown" at concurrency two.
  // Durable region jobs retry if the entire pending capacity is exhausted.
  if(pending.size>=maxPending)return UNKNOWN;
  const task=(async()=>{
   await acquire();let region=UNKNOWN;
   try{
    const headers={'User-Agent':'Mozilla/5.0 (compatible; KFChat/1.0.4)','Accept':'text/html'};
    try{
     const response=await fetchImpl(`${SOURCE}/ip/${encodeURIComponent(ip)}.html`,{headers,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
     if(!response.headers.get('content-type')?.includes('text/html')){await response.body?.cancel();throw new Error('Invalid IP.cn content');}
     region=parseIpCnPage(await responseBody(response),ip);
    }catch{/* Try the configured secondary provider below. */}
    if(region===UNKNOWN&&now()>=secondaryUntil){
     try{
      const response=await fetchImpl(`https://ipwho.is/${encodeURIComponent(ip)}?lang=zh-CN&fields=success,ip,country,region,city`,{headers:{...headers,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
      if(response.status===429){
       const retry=response.headers.get('retry-after'),seconds=retry&&/^\d+$/.test(retry)?Number(retry):(Date.parse(retry)-now())/1000;
       secondaryUntil=now()+Math.min(86400000,Math.max(1000,Number.isFinite(seconds)&&seconds>=0?seconds*1000:60000));
      }
      region=parseIpWhoIsResponse(await responseBody(response),ip);
     }catch{/* Both providers unavailable: the durable job can retry later. */}
    }
   }finally{release();}
   cache.delete(ip);cache.set(ip,{region,until:now()+(region===UNKNOWN?60000:cacheMs)});
   while(cache.size>maxEntries)cache.delete(cache.keys().next().value);
   return region;
  })();
  pending.set(ip,task);
  try{return await task;}finally{pending.delete(ip);}
 };
}
