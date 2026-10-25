const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../advanced-host/series.js'), 'utf8'), context);
for (const source of ['FXCM', 'YAHOO', 'DUKA', 'NATIVE']) {
  context.ticker = 'MWP:' + source + ':' + 'abcdef01'.repeat(4);
  assert.equal(vm.runInContext('MWSeries.decode(ticker.toUpperCase()).symbol', context), context.ticker.slice(4));
  assert.equal(vm.runInContext('MWSeries.same(ticker, ticker.toUpperCase())', context), true);
}
console.log('Native hash identity casing passed');
