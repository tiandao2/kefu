import {BlockList,isIP} from 'node:net';
const UNKNOWN='未知地区',SOURCE='https://ip.cn';
const privateNetworks=new BlockList();
for(const [ip,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])privateNetworks.addSubnet(ip,prefix,'ipv4');
for(const [ip,prefix] of [['::',96],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32],['2001:2::',48]])privateNetworks.addSubnet(ip,prefix,'ipv6');
function publicIp(value){
 let ip=typeof value==='string'?value.trim():'';
 if(ip.startsWith('::ffff:')){
  const tail=ip.slice(7);
  if(isIP(tail)===4)ip=tail;
  else if(/^[a-f\d]{1,4}:[a-f\d]{1,4}$/i.test(tail)){
   const n=tail.split(':').map(x=>parseInt(x,16));ip=[n[0]>>>8,n[0]&255,n[1]>>>8,n[1]&255].join('.');
  }
 }
 const family=isIP(ip);if(!family||ip.includes('%')||privateNetworks.check(ip,family===4?'ipv4':'ipv6'))return null;
 // Only global IPv6 unicast; reject unspecified, loopback and scoped addresses.
 if(family===6&&!/^[23][a-f\d]{0,3}:/i.test(ip))return null;
 return ip.toLowerCase();
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
 if(echoed!==requestedIp.toLowerCase()||!region||/未知|无法|查询失败|验证码|请核实/.test(region))return UNKNOWN;
 return region.replace(/^中国(?:\s+|$)/,'').replace(/\s+/g,'').slice(0,64)||UNKNOWN;
}
export function createIpCnLookup({enabled=true,fetchImpl=fetch,timeoutMs=2000,cacheMs=86400000,maxEntries=512,maxConcurrent=2,now=Date.now}={}){
 const cache=new Map(),pending=new Map();let active=0;
 return async value=>{
  const ip=publicIp(value);if(!enabled||!ip)return UNKNOWN;
  const saved=cache.get(ip);if(saved&&saved.until>now())return saved.region;
  if(pending.has(ip))return pending.get(ip);
  if(active>=maxConcurrent)return UNKNOWN;
  const task=(async()=>{
   active++;let region=UNKNOWN;
   try{
    const response=await fetchImpl(`${SOURCE}/ip/${encodeURIComponent(ip)}.html`,{headers:{'User-Agent':'Mozilla/5.0 (compatible; KFChat/1.0.2)','Accept':'text/html'},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok||!response.headers.get('content-type')?.includes('text/html'))throw new Error('Invalid IP.cn response');
    const reader=response.body.getReader();const chunks=[];let bytes=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>256000)throw new Error('IP.cn response too large');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
    region=parseIpCnPage(Buffer.concat(chunks).toString('utf8'),ip);
   }catch{/* External lookup failures must never stop visitor initialization. */}
   finally{active--;}
   cache.delete(ip);cache.set(ip,{region,until:now()+(region===UNKNOWN?60000:cacheMs)});
   while(cache.size>maxEntries)cache.delete(cache.keys().next().value);
   return region;
  })();
  pending.set(ip,task);
  try{return await task;}finally{pending.delete(ip);}
 };
}
