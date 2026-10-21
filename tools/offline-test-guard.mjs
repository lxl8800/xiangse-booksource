// Loaded only by the test runner, never by the application.
// Fail accidental external DNS/HTTP calls; loopback fake servers remain usable.
import dns from 'node:dns';
import {syncBuiltinESMExports} from 'node:module';
const originalLookup=dns.lookup.bind(dns);
const originalPromiseLookup=dns.promises.lookup.bind(dns.promises);
const local=host=>['localhost','127.0.0.1','::1','[::1]'].includes(String(host).toLowerCase());
const forbidden=()=>Object.assign(new Error('Offline tests must inject a DNS/fetch stub instead of contacting external services'),{code:'OFFLINE_NETWORK_FORBIDDEN'});
dns.lookup=function(host,options,callback){
  if(local(host))return originalLookup(host,options,callback);
  const cb=typeof options==='function'?options:callback;
  if(typeof cb==='function'){queueMicrotask(()=>cb(forbidden()));return;}
  throw forbidden();
};
dns.promises.lookup=async function(host,options){if(!local(host))throw forbidden();return originalPromiseLookup(host,options);};
for(const key of ['resolve','resolve4','resolve6','resolveAny','reverse']){
  dns[key]=(...args)=>{const cb=args.at(-1);if(typeof cb==='function'){queueMicrotask(()=>cb(forbidden()));return;}throw forbidden();};
  dns.promises[key]=async()=>{throw forbidden();};
}
if(globalThis.fetch){
  const originalFetch=globalThis.fetch;
  globalThis.fetch=function(input,options){
    const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);
    if(!local(url.hostname))return Promise.reject(forbidden());
    return originalFetch(input,options);
  };
}
syncBuiltinESMExports();
