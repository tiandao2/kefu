// Only loaded by the isolated region integration tests through --import.
const nativeFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{
 const url=new URL(String(input));
 if(['ip.cn','ipwho.is'].includes(url.hostname))return nativeFetch(`${process.env.KF_GEO_TEST_URL}/${url.hostname}${url.pathname}${url.search}`,options);
 return nativeFetch(input,options);
};
