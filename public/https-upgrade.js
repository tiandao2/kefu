// Some mobile webviews retain an http: document URL after a transport upgrade.
// Navigate the document itself before API calls, Secure cookies or WebSockets.
(() => {
 const loopback=['localhost','127.0.0.1','[::1]'].includes(location.hostname);
 if(location.protocol==='http:'&&!loopback){
  const destination=new URL(location.href);destination.protocol='https:';
  location.replace(destination.href);
 }
})();
