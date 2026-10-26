// Controlled application client for adapter concurrency tests. Delivery is held
// until the test completes it; production invokes these Promise functions directly.
const fs=require('node:fs');
function source(code){return `
const testReplies=new Map();
const testObserve=value=>parent.postMessage(value);
const testCall=(type,query,context)=>new Promise((resolve,reject)=>{
 testReplies.set(context.id,{resolve,reject});testObserve({type,query,...context});
});
const application={observe:testObserve,market:testCall,workspace:testCall,session:testCall,alerts:testCall,notifications:testCall,dataCenter:testCall,
 cancel:id=>testObserve({type:'cancel-request',id})};
`+code.replace(/return adapter;\s*$/, '')+`
addEventListener('message',async event=>{
 const value=event.data;
 if(value.type==='result'){
  const reply=testReplies.get(value.id);testReplies.delete(value.id);
  if(reply){value.error?reply.reject(Object.assign(Error(value.error),value.errorDetails)):reply.resolve(value.result);await Promise.resolve();await Promise.resolve();}
 }else await update(value);
});
`;}
function read(file,encoding){const code=fs.readFileSync(file,encoding);return String(file).endsWith('chart-runtime.js')?source(code):code;}
module.exports={read,source};
