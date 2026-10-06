const {request}=require('/home/quant/repos/market-watch-range-main/web/node_modules/@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const ctx=await request.newContext({ignoreHTTPSErrors:true});try{
 const APP='https://192.168.7.232:16843';const login=await ctx.post(APP+'/api/login',{data:JSON.parse(fs.readFileSync('/home/quant/repos/.acceptance/range-main-20261006/login.json'))});assert.ok(login.ok());
 const csrf=(await login.json()).csrf;const r=await ctx.post(APP+'/api/charts/history-capacity',{headers:{'X-CSRF-Token':csrf},data:{max_bars:Number(process.argv[2])}});assert.ok(r.ok(),r.status());console.log('isolated capacity',Number(process.argv[2]));
 }finally{await ctx.dispose()}
})().catch(e=>{console.error(e);process.exitCode=1});
