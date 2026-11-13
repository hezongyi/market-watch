// The supplied v31 archive includes Hammer itself, but omits the tiny module
// exporting it for this version of floating-toolbars. Add a host-owned module
// bridge in build staging; never edit or duplicate licensed source bundles.
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';

export function prepareNativeTouchAssets(library) {
  const bundles = new URL('bundles/', library);
  const inputs = [
    ['72141.3ae0b3f3d967c34a9e5d.js', '31323b2b3ee53ceae21056215262d7423a02f7f8fdea0e07433f237745b48ad2'],
    ['floating-toolbars.47df2a0632b65c8dff7b.js', 'eb75952746bd9dd72c9dad6acadfc8655e42e64a8bb3cfd04f480ded04f3a494'],
  ];
  for (const [name, expected] of inputs) {
    const hash = createHash('sha256').update(readFileSync(new URL(name, bundles))).digest('hex');
    if (hash !== expected) throw Error('Unsupported native touch modules: verify the pinned v31 archive');
  }
  const bridge = `/* Market Watch compatibility bridge; uses the unchanged native Hammer module. */
(self.webpackChunktradingview=self.webpackChunktradingview||[]).push([[85652],{
  682937:(module,exports,require)=>{module.exports={HammerJS:require(172141)};}
}]);\n`;
  writeFileSync(new URL('hammerjs.faf756299593572313c8.js', bundles), bridge);
  return bridge;
}
