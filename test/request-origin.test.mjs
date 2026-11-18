import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestOriginAllowed} from '../request-origin.mjs';
const allowed=new Set(['https://kf.wgioat.cn']);
test('exact origins and absent-origin same-origin Referer are accepted',()=>{
 assert.equal(requestOriginAllowed({origin:'https://kf.wgioat.cn'},allowed),true);
 assert.equal(requestOriginAllowed({referer:'https://kf.wgioat.cn/?private=not-recorded'},allowed),true);
});
test('HTTP, foreign, opaque, missing or malformed sources remain denied',()=>{
 for(const headers of [{origin:'http://kf.wgioat.cn'}, {referer:'http://kf.wgioat.cn/'},{origin:'https://evil.example',referer:'https://kf.wgioat.cn/'},{origin:'null',referer:'https://kf.wgioat.cn/'},{},{referer:'https://kf.wgioat.cn.evil.example/'},{referer:'not-a-url'},{origin:['https://kf.wgioat.cn']}])assert.equal(requestOriginAllowed(headers,allowed),false,JSON.stringify(headers));
});
