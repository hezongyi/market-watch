const assert=require('node:assert/strict'),vm=require('node:vm'),{build}=require('esbuild');
(async()=>{
 const built=await build({entryPoints:['src/mobile/alerts.ts'],bundle:true,write:false,format:'iife',globalName:'Alerts',platform:'browser'});
 const scope={AbortSignal,DOMException,Error,JSON,structuredClone,console,window:{},setTimeout,clearTimeout};vm.createContext(scope);vm.runInContext(built.outputFiles[0].text,scope);
 const {newPriceConfig,admission,savePriceRule,editablePrice}=scope.Alerts;
 const config=newPriceConfig('a'.repeat(64),'fixed-revision');assert.equal(config.association,null);
 const caps={sources:[{source:'composite',series_kind:'composite',available:false,price_modes:{intrabar:{available:true},close:{available:false}}}]};
 assert.equal(admission(caps,{...config,mode:'intrabar'}).available,true);assert.equal(admission(caps,config).available,false);
 const row={id:'r',config:{...config,association:{workspace_id:'desktop',object_kind:null}},status:'active',version:1,control_revision:1};
 assert.equal(editablePrice(row),true);assert.equal(editablePrice({...row,config:{...config,series_kind:'provider'}}),false);
 const draft=structuredClone(row.config);draft.name='changed';
 const calls=[];const saved=await savePriceRule(draft,'same',row,async(path,body)=>{calls.push({path,body});if(body)throw new TypeError('lost response');return {...row,version:2,config:draft};});
 assert.equal(saved.version,2);assert.equal(calls.length,2);assert.equal(calls[0].body.version,1);assert.equal(calls[0].body.config.association.workspace_id,'desktop');
 await assert.rejects(savePriceRule(draft,'same',row,async(path,body)=>{if(body)throw new TypeError('lost response');return {...row,version:2,config:{...draft,message:'other edit'}};}));
 let writes=0;await assert.rejects(savePriceRule(draft,'same',{...row,config:{...config,series_kind:'provider'}},async()=>{writes++;}));assert.equal(writes,0);
 console.log('PASS mobile alert admission, null/preserved association, lost edit full-config/version verification and retired-source write guard');
})().catch(error=>{console.error(error);process.exitCode=1;});
