// One Vite entry plus the pinned native chart adapter. Never edit the licensed source.
import {cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=resolve('..'), host=join(root,'advanced-host'), stage=mkdtempSync(join(tmpdir(),'mw-chart-build-'));
const run=(file,args=[],cwd=stage)=>execFileSync(process.execPath,[file,...args],{cwd,stdio:'inherit'});
try {
  if(!existsSync(join(host,'charting_library/charting_library.js')))throw Error('Install the licensed pinned charting_library locally before building');
  for(const name of readdirSync(host))if(/\.(js|mjs|css)$/.test(name))cpSync(join(host,name),join(stage,name));
  cpSync(join(host,'charting_library'),join(stage,'charting_library'),{recursive:true});
  run(resolve('scripts/build-alert-ui.mjs'),[stage],resolve('.'));
  run(join(stage,'patch-native-reserve.mjs'),process.env.NATIVE_RESERVE_ENABLED==='false'?['--disable']:[]);
  run(join(stage,'patch-native-toolset.mjs'));
  run(join(stage,'build-assets.mjs'));
  const manifest=JSON.parse(readFileSync(join(stage,'chart-assets.json')));
  for(const name of ['chart-assets.json',manifest.script,manifest.libraryDirectory,'chart-menu.css','indicator-picker.css','alert-ui.css'])
    if(existsSync(join(stage,name)))cpSync(join(stage,name),resolve('dist',name),{recursive:true});
  run(resolve('scripts/build-data-center.mjs'),[],resolve('.'));
} finally {rmSync(stage,{recursive:true,force:true});}
