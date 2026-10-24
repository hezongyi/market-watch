const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const exportsObject={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/apiErrors.ts','utf8'),
 {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:exportsObject});
const {responseError,rpcError}=exportsObject;
const safe={reason:'ttl',attempt_ref:'a'.repeat(32),credential_ref:'b'.repeat(16)};
let error=responseError({code:'DISPLAY_SNAPSHOT_EXPIRED',message:'展示快照已过期',snapshot_evidence:{...safe,password:'must not survive'}},422);
assert.deepEqual(JSON.parse(JSON.stringify(error.snapshot_evidence)),safe);
assert.deepEqual(JSON.parse(JSON.stringify(rpcError(error).snapshot_evidence)),safe);
assert.equal(responseError({message:'旧服务响应'},422).snapshot_evidence,undefined);
for(const evidence of [{...safe,reason:'https://private.example/token'}, {...safe,credential_ref:'raw-token'},
 {...safe,attempt_ref:'private-account'}, null])
 assert.equal(responseError({snapshot_evidence:evidence},422).snapshot_evidence,undefined);
console.log('PASS optional snapshot evidence survives HTTP/RPC; unknown or private values are excluded');
