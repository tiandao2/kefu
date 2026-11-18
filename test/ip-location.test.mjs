import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createIpCnLookup,parseIpCnPage} from '../ip-location.mjs';
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
