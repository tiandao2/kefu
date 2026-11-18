import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createIpCnLookup,parseIpCnPage,parseIpWhoIsResponse} from '../ip-location.mjs';
const page=(ip,region)=>`<table><tr><th>您查询的IP</th><td><span>${ip}</span><a>Ping</a></td></tr><tr><th><span>所在地理位置</span></th><td><span>${region}</span><a>查看区县</a></td></tr></table>`;
test('IP.cn location comes from the geography cell rather than ISP or links',()=>{
 assert.equal(parseIpCnPage(page('223.5.5.5','中国 浙江 杭州'),'223.5.5.5'),'浙江杭州');
 assert.equal(parseIpCnPage(page('1.1.1.1','澳大利亚 新南威尔士 悉尼'),'1.1.1.1'),'澳大利亚新南威尔士悉尼');
 assert.equal(parseIpCnPage(page('223.5.5.5','中国&nbsp;广东省&#32;深圳市'),'223.5.5.5'),'广东省深圳市');
 assert.equal(parseIpCnPage(page('223.5.5.5','中国 浙江 杭州'),'1.1.1.1'),'未知地区');
 assert.equal(parseIpCnPage(page('2400:3200::1','您的IP或者域名无法解析，请核实后再查询！'),'2400:3200::1'),'未知地区');
});
test('lookup uses only IP.cn, deduplicates concurrent lookups, caches and expires',async()=>{
 let calls=0,time=10000;const urls=[];
 const lookup=createIpCnLookup({now:()=>time,cacheMs:500,fetchImpl:async(url,options)=>{calls++;urls.push(url);assert.equal(options.redirect,'error');return new Response(page('223.5.5.5','中国 浙江 杭州'),{headers:{'content-type':'text/html; charset=UTF-8'}});}});
 assert.deepEqual(await Promise.all([lookup('223.5.5.5'),lookup('223.5.5.5')]),['浙江杭州','浙江杭州']);assert.equal(calls,1);
 assert.equal(await lookup('223.5.5.5'),'浙江杭州');assert.equal(calls,1);time+=501;await lookup('223.5.5.5');assert.equal(calls,2);
 assert.ok(urls.every(u=>u==='https://ip.cn/ip/223.5.5.5.html'));
});
test('private, malformed, mapped private and disabled IPs never leave the server',async()=>{
 let calls=0;const lookup=createIpCnLookup({fetchImpl:async()=>{calls++;throw Error('Should not fetch');}});
 for(const ip of ['127.0.0.1','10.1.1.1','172.16.2.1','192.168.1.1','::1','::ffff:127.0.0.1','::ffff:7f00:1','fc00::1','fe80::1','2001:db8::1','1.2.3.4/../../../','test.example',''])assert.equal(await lookup(ip),'未知地区',ip);
 assert.equal(calls,0);const disabled=createIpCnLookup({enabled:false,fetchImpl:async()=>{calls++;}});assert.equal(await disabled('223.5.5.5'),'未知地区');assert.equal(calls,0);
});
test('timeouts, redirects, malformed and oversized responses fail to unknown without escaping',async()=>{
 for(const fetchImpl of [async()=>{throw Error('redirect');},async()=>new Response('bad',{status:503}),async()=>new Response('bad',{headers:{'content-type':'application/json'}}),async()=>new Response('x'.repeat(256001),{headers:{'content-type':'text/html'}}),async(_,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason)))]){
  const lookup=createIpCnLookup({fetchImpl,timeoutMs:20});const keepAlive=setTimeout(()=>{},100);
  try{assert.equal(await lookup('223.5.5.5'),'未知地区');}finally{clearTimeout(keepAlive);}
 }
});

test('twenty different IPs wait for capacity, never exceed two requests and deduplicate queued IPs',async()=>{
 let active=0,maxActive=0,calls=0;
 const lookup=createIpCnLookup({fetchImpl:async url=>{
  calls++;active++;maxActive=Math.max(active,maxActive);await new Promise(r=>setTimeout(r,10));active--;
  const ip=decodeURIComponent(new URL(url).pathname.slice(4,-5));
  return new Response(page(ip,'中国 浙江 杭州'),{headers:{'content-type':'text/html'}});
 }});
 const ips=Array.from({length:20},(_,i)=>`8.8.8.${i+1}`);
 const results=await Promise.all([...ips,ips[19]].map(ip=>lookup(ip)));
 assert.ok(results.every(r=>r==='浙江杭州'));assert.equal(calls,20);assert.equal(maxActive,2);
});

test('canonical IPv6 and mapped IPv4 are compared by address while real mismatches remain rejected',async()=>{
 assert.equal(parseIpCnPage(page('2400:3200::1','中国 浙江 杭州'),'2400:3200:0:0:0:0:0:1'),'浙江杭州');
 assert.equal(parseIpCnPage(page('2400:3200::2','中国 浙江 杭州'),'2400:3200:0:0:0:0:0:1'),'未知地区');
 let url;const lookup=createIpCnLookup({fetchImpl:async u=>{url=u;return new Response(page('223.5.5.5','中国 浙江 杭州'),{headers:{'content-type':'text/html'}});}});
 assert.equal(await lookup('::FFFF:df05:505'),'浙江杭州');assert.equal(url,'https://ip.cn/ip/223.5.5.5.html');
});

test('token-free secondary is requested in Chinese only after primary failure',async()=>{
 const calls=[];
 const lookup=createIpCnLookup({fetchImpl:async(url,options)=>{
  calls.push({url,options});assert.equal(options.redirect,'error');
  if(new URL(url).hostname==='ip.cn')throw Error('primary unavailable');
  const parsed=new URL(url);assert.equal(parsed.hostname,'ipwho.is');assert.equal(parsed.searchParams.get('lang'),'zh-CN');assert.equal(parsed.searchParams.get('fields'),'success,ip,country,region,city');assert.equal(options.headers.token,undefined);assert.equal(options.headers.Authorization,undefined);
  return new Response(JSON.stringify({success:true,ip:'223.5.5.5',country:'中国',region:'浙江',city:'杭州',connection:{isp:'运营商应被排除'}}));
 }});
 assert.equal(await lookup('223.5.5.5'),'浙江杭州');assert.equal(calls.length,2);
 assert.equal(await lookup('223.5.5.5'),'浙江杭州');assert.equal(calls.length,2);
 const primary=createIpCnLookup({fetchImpl:async url=>{assert.equal(new URL(url).hostname,'ip.cn');return new Response(page('1.1.1.1','澳大利亚'),{headers:{'content-type':'text/html'}});}});
 assert.equal(await primary('1.1.1.1'),'澳大利亚');
});

test('secondary validates address, Chinese fields, failed results and malformed content',async()=>{
 const valid={success:true,ip:'223.5.5.5',country:'中国',region:'浙江',city:'杭州'};
 for(const body of ['null','{}','[]','invalid json'])assert.equal(parseIpWhoIsResponse(body,'223.5.5.5'),'未知地区');
 for(const data of [{...valid,success:false},{...valid,ip:'1.1.1.1'},{...valid,ip:undefined},{...valid,region:'未知地区'},{...valid,city:12},{...valid,country:'China'}])assert.equal(parseIpWhoIsResponse(JSON.stringify(data),'223.5.5.5'),'未知地区');
 assert.equal(parseIpWhoIsResponse(JSON.stringify({...valid,ip:'2400:3200::1'}),'2400:3200:0:0:0:0:0:1'),'浙江杭州');
 assert.equal(parseIpWhoIsResponse(JSON.stringify({...valid,ip:'8.8.8.8',country:'美国',region:'加利福尼亚州',city:'聖荷西'}),'8.8.8.8'),'美国加利福尼亚州聖荷西');
 assert.equal(parseIpWhoIsResponse(JSON.stringify({...valid,country:'美国',region:'California',city:'San Jose'}),'223.5.5.5'),'美国');
 let calls=0;const lookup=createIpCnLookup({fetchImpl:async()=>{calls++;return new Response('{}',{status:202});}});
 assert.equal(await lookup('223.5.5.5'),'未知地区');assert.equal(calls,2);
});

test('secondary rate limits pause all new fallback requests until Retry-After expires',async()=>{
 for(const dateHeader of [false,true]){
  let time=Date.UTC(2026,10,18),secondaryCalls=0;
  const lookup=createIpCnLookup({now:()=>time,fetchImpl:async url=>{
   const u=new URL(url);if(u.hostname==='ip.cn')throw Error('primary unavailable');secondaryCalls++;
   if(secondaryCalls===1)return new Response('{}',{status:429,headers:{'retry-after':dateHeader?new Date(time+120000).toUTCString():'120'}});
   return new Response(JSON.stringify({success:true,ip:decodeURIComponent(u.pathname.slice(1)),country:'中国',region:'浙江',city:'杭州'}));
  }});
  assert.equal(await lookup('8.8.8.1'),'未知地区');assert.equal(await lookup('8.8.8.2'),'未知地区');assert.equal(secondaryCalls,1);
  time+=121000;assert.equal(await lookup('8.8.8.2'),'浙江杭州');assert.equal(secondaryCalls,2);
 }
});

test('capacity overflow is bounded and can be retried once capacity recovers',async()=>{
 let release;const gate=new Promise(r=>release=r);
 const lookup=createIpCnLookup({maxPending:2,maxConcurrent:1,fetchImpl:async url=>{await gate;const ip=decodeURIComponent(new URL(url).pathname.slice(4,-5));return new Response(page(ip,'中国 浙江 杭州'),{headers:{'content-type':'text/html'}});}});
 const a=lookup('8.8.8.1'),b=lookup('8.8.8.2');assert.equal(await lookup('8.8.8.3'),'未知地区');release();await Promise.all([a,b]);assert.equal(await lookup('8.8.8.3'),'浙江杭州');
});
