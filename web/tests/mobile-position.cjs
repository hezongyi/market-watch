const assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript'), vm = require('node:vm');
function load(file) { const exports = {}; vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, BigInt }); return exports; }
const { calculatePosition: calc, normalizePrice } = load('src/mobile/positionCalculator.ts');
const { positionContracts: contracts } = load('src/mobile/positionContracts.ts');
assert.equal(contracts.length,60);
const cases = [
 ['EUR/USD','long','1.1000','1.0980',undefined,'0.50','100.00'],
 ['EUR/USD','long','1.1000','1.0960',undefined,'0.25','100.00'],
 ['USD/JPY','long','150.00','149.80',undefined,'0.74','98.80'],
 ['USD/JPY','short','150.00','150.20',undefined,'0.75','99.87'],
 ['USD/JPY','long','150.00','149.50',undefined,'0.29','96.99'],
 ['EUR/JPY','long','160.00','159.80','150.00','0.75','100.00'],
 ['EUR/GBP','long','0.8600','0.8580','1.2500','0.40','100.00'],
 ['XAU/USD','long','2600.00','2590.00',undefined,'0.10','100.00'],
 ['EUR/USD','long','1.1000','1.0950',undefined,'0.20','100.00'],
];
for (const [symbol,direction,entry,stop,conversion,lots,loss] of cases) {
 const value=calc(contracts.find(x=>x.symbol===symbol),{risk:'100',direction,entry,stop,conversion});
 assert.equal(value.result?.lots,lots,symbol+JSON.stringify(value));assert.equal(value.result?.loss,loss);
}
const eur=contracts.find(x=>x.symbol==='EUR/USD'),gold=contracts.find(x=>x.gold);
for (const [risk,lots] of [['99.99','0.19'],['100.00','0.20'],['100.01','0.20']]) assert.equal(calc(eur,{risk,direction:'long',entry:'1.1000',stop:'1.0950'}).result.lots,lots);
assert.equal(normalizePrice('1.10005',4),'1.1001');assert.equal(normalizePrice('150.005',2),'150.01');
assert(!calc(gold,{risk:'5',direction:'long',entry:'2600.00',stop:'2590.00'}).result);
assert(!calc(eur,{risk:'100',direction:'long',entry:'1.10005',stop:'1.0980'}).result);
for(const stop of ['1.1000','1.2000','0','abc','1.'])assert(!calc(eur,{risk:'100',direction:'long',entry:'1.1000',stop}).result);
assert.equal(calc({...eur,minimum:'0.03',step:'0.02'},{risk:'100',direction:'long',entry:'1.1000',stop:'1.0980'}).result.lots,'0.49');
console.log('position: 60 offline presets, 9 independent cases, exact JPY conversion, half-up and boundaries passed');
