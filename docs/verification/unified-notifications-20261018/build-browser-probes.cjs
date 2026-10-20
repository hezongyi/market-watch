const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const repo = path.resolve(process.argv[2] || path.join(__dirname, '../../..'));
const { build } = createRequire(path.join(repo, 'web/package.json'))('esbuild');
fs.mkdirSync('/tmp/mw75-playwriter', { recursive: true });
build({stdin:{contents:'export {NoticeStore} from "./src/notifications/store";export {NoticeRuntime} from "./src/notifications/runtime";',resolveDir:path.join(repo,'web'),loader:'ts'},bundle:true,format:'iife',globalName:'NoticeProbes',platform:'browser',outfile:'/tmp/mw75-playwriter/probes.bundle.js',plugins:[{name:'isolated-api',setup(b){b.onLoad({filter:/\/src\/api\.ts$/},()=>({contents:'export class ApiError extends Error {constructor(message,status,code){super(message);this.status=status;this.code=code;}};export const api=(...args)=>globalThis.probeAPI(...args);',loader:'js'}))}}]}).catch(e=>{console.error(e);process.exitCode=1});
