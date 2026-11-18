function originFromReferer(value){
 try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.origin:null;}catch{return null;}
}
export function requestOriginAllowed(headers,allowedOrigins){
 // An explicit foreign or opaque Origin must never be rescued by a Referer.
 if(headers.origin!==undefined)return typeof headers.origin==='string'&&allowedOrigins.has(headers.origin);
 // Older webviews may omit Origin; require an exact trusted Referer instead.
 const referer=originFromReferer(headers.referer);
 return !!referer&&allowedOrigins.has(referer);
}
export function originDiagnostic(headers){
 return {origin:headers.origin===undefined?'missing':headers.origin==='null'?'null':originFromReferer(headers.origin)||'invalid',refererOrigin:originFromReferer(headers.referer),fetchSite:['same-origin','same-site','cross-site','none'].includes(headers['sec-fetch-site'])?headers['sec-fetch-site']:'missing'};
}
