/* Nine independent drawing intervals in the pinned native property/undo model.
 * -1 preserves legacy category ranges; no active-pane visible flag is changed. */
const MWDrawingVisibilityAdapter = (() => {
  const expected = '6b804c486857f27920cf761aa7eb6e29d9bb6362';
  const resolutions = ['1','5','15','30','60','240','1D','1W','1M'];
  const labels = ['M1','M5','M15','M30','H1','H4','D1','W1','MN'];
  const valid = mask => Number.isInteger(mask) && mask >= 0 && mask <= 511;
  function ensure(properties) {
    const children = properties.childs();
    if (!children.mwMask && children.minutes)
      properties.addChild('mwMask', new children.minutes.constructor(-1));
  }
  function actual(interval, properties) {
    const mask = properties.childs().mwMask?.value();
    const raw = interval.value(), resolution = ({D:'1D',W:'1W',M:'1M'})[raw] || raw;
    const index = resolutions.indexOf(resolution);
    return valid(mask) && index >= 0 ? !!(mask & (1 << index)) : undefined;
  }
  function install(win) {
    if (!String(TradingView.version()).includes(expected)) throw Error('绘图可见周期版本尚未适配');
    if (win.mwDrawingVisibilityInstalled) return;
    let req;
    win.webpackChunktradingview.push([[`mw-drawing-visibility-${crypto.randomUUID()}`], {}, value => {req=value;}]);
    const wrap = original => {
      if (original.mwDrawingVisibility) return original;
      function adapted(module, exports, require) {
        original(module, exports, require);
        const native = module.exports;
        const legacyMask = children => resolutions.reduce((mask, resolution, index) => mask |
          (require(722618).isActualInterval(require(738318).Interval.parse(resolution),
            {childs:()=>({...children,mwMask:undefined})}) ? 1 << index : 0), 0);
        const rangeDefinitions = (children,model) => {
          const definitions=require(937298),Text=require(411227).TranslatedString;
          const Collected=require(956879).LineToolCollectedProperty;
          const UndoWrapper=require(614807).CollectiblePropertyUndoWrapper;
          const WatchedValue=require(963325).WatchedValue;
          const objects=children.mwMask.map((_,i)=>Object.fromEntries(
            Object.entries(children).map(([key,values])=>[key,values[i]])));
          const maskAt=i=>valid(objects[i].mwMask.value()) ? objects[i].mwMask.value() : legacyMask(objects[i]);
          const categories=[
            {key:'minutes',title:'分钟',indices:[0,1,2,3],values:[1,5,15,30],max:59},
            {key:'hours',title:'小时',indices:[4,5],values:[1,4],max:24},
            {key:'days',title:'天',indices:[6],values:[1],max:366},
            {key:'weeks',title:'周',indices:[7],values:[1],max:52},
            {key:'months',title:'月',indices:[8],values:[1],max:12},
          ];
          const apply=(applier,property,value)=>{
            if(property.value()===value)return;
            if(applier)applier.applyValue(property,value);else property.setValue(value);
          };
          const bounds=(i,category)=>{
            const object=objects[i],mask=maskAt(i);
            const values=category.values.filter((_,j)=>mask & (1 << category.indices[j]));
            const from=object[category.key+'From'].value(),to=object[category.key+'To'].value();
            const raw=object[category.key].value() ? category.values.filter(n=>n>=from && n<=to) : [];
            if(values.length===raw.length && values.every((n,j)=>n===raw[j]))
              return {checked:object[category.key].value(),from,to};
            return {checked:values.length>0,
              from:values.length ? Math.min(...values) : object[category.key+'From'].value(),
              to:values.length ? Math.max(...values) : object[category.key+'To'].value()};
          };
          return categories.flatMap(category=>{
            const property=field=>{
              class RangeCollection extends Collected {
                constructor(){super(objects.flatMap(object=>[object.mwMask,object[category.key],
                  object[category.key+'From'],object[category.key+'To']]));}
                value(){
                  const values=objects.map((_,i)=>bounds(i,category)[field]);
                  return values.every(value=>value===values[0]) ? values[0] : 'mixed';
                }
                setValue(value,unused,applier){
                  if(value==='mixed')return;
                  objects.forEach((object,i)=>{
                    if(bounds(i,category)[field]===value)return;
                    const mask=maskAt(i),state={...bounds(i,category),[field]:value};
                    // Raw bounds and the effective mask share the native undo
                    // transaction. Opening or undoing never expands a mask.
                    apply(applier,object[category.key],state.checked);
                    apply(applier,object[category.key+'From'],state.from);
                    apply(applier,object[category.key+'To'],state.to);
                    const bits=category.indices.reduce((mask,index)=>mask | (1 << index),0);
                    const selected=category.values.reduce((mask,n,j)=>mask |
                      (state.checked && n>=state.from && n<=state.to ? 1 << category.indices[j] : 0),0);
                    apply(applier,object.mwMask,(mask & ~bits) | selected);
                  });
                }
              }
              return new UndoWrapper(new RangeCollection(),new Text('change drawing range',`修改绘图${category.title}范围`),model);
            };
            class SelectionStatus extends Collected {
              constructor(){super(objects.flatMap(object=>[object.mwMask,object[category.key],
                object[category.key+'From'],object[category.key+'To']]));}
              value(){
                const states=objects.map((_,i)=>{
                  const mask=maskAt(i),state=bounds(i,category);
                  const selected=category.values.filter((_,j)=>mask & (1 << category.indices[j]));
                  if(!selected.length)return state.checked ? '该范围没有可用的已选周期' : '未选择周期';
                  const continuous=category.values.filter(n=>n>=selected[0] && n<=selected.at(-1));
                  return (selected.length!==continuous.length ? '自定义周期：' : '已选周期：')+
                    category.indices.filter(index=>mask & (1 << index)).map(index=>labels[index]).join('、');
                });
                return states.every(state=>state===states[0]) ? states[0] : '混合周期';
              }
              setValue(){} // Native read-only text; effective values belong to mwMask.
            }
            return [definitions.createRangePropertyDefinition({checked:property('checked'),from:property('from'),to:property('to')},
              {id:'MWDrawingRange'+category.key,title:category.title,min:new WatchedValue(1),max:new WatchedValue(category.max)}),
              definitions.createTextPropertyDefinition({text:new SelectionStatus()},
                {id:'MWDrawingSelection'+category.key,title:'',isEditable:false})];
          });
        };
        module.exports = {...native, getIntervalsVisibilitiesPropertiesDefinitions(model, children, title) {
          // The shared definitions module also serves studies; preserve them.
          if (!children.mwMask) return native.getIntervalsVisibilitiesPropertiesDefinitions(model, children, title);
          const definitions = require(937298);
          const Text = require(411227).TranslatedString;
          return {definitions: [...rangeDefinitions(Object.fromEntries(Object.entries(children).map(([key,value])=>[key,[value]])),model), ...labels.map((label, index) => {
            const bit = 1 << index;
            const read = mask => !!((valid(mask) ? mask : legacyMask(children)) & bit);
            const write = checked => {
              const value = children.mwMask.value(), mask = valid(value) ? value : legacyMask(children);
              return checked ? mask | bit : mask & ~bit;
            };
            const checked = definitions.convertToDefinitionProperty(model, children.mwMask,
              new Text(`change drawing visibility on ${label}`, `修改绘图在 ${label} 的可见性`), [read,write]);
            return definitions.createCheckablePropertyDefinition({checked}, {id:`MWDrawingVisibility${label}`,title:label});
          })]};
        }, getSelectionIntervalsVisibilitiesPropertiesDefinition(children, model) {
          if (!children.mwMask?.length)
            return native.getSelectionIntervalsVisibilitiesPropertiesDefinition(children, model);
          const definitions = require(937298), Text = require(411227).TranslatedString;
          const Collected = require(956879).LineToolCollectedProperty;
          const UndoWrapper = require(614807).CollectiblePropertyUndoWrapper;
          return {definitions: [...rangeDefinitions(children,model), ...labels.map((label, index) => {
            const bit = 1 << index, properties = children.mwMask;
            const maskAt = i => {
              const value = properties[i].value();
              return valid(value) ? value : legacyMask(Object.fromEntries(
                Object.entries(children).map(([key, values])=>[key,values[i]])));
            };
            // The native collector owns subscriptions and the undo macro. Apply
            // raw masks through its applier so each object's other bits survive,
            // including mixed selections and explicitly edited legacy ranges.
            class PeriodCollection extends Collected {
              value() {
                const values = properties.map((_,i)=>!!(maskAt(i) & bit));
                return values.every(value=>value===values[0]) ? values[0] : 'mixed';
              }
              setValue(checked, unused, applier) {
                if (checked==='mixed') return;
                properties.forEach((property,i)=>{
                  const mask=maskAt(i), value=checked ? mask | bit : mask & ~bit;
                  if (applier) applier.applyValue(property,value);
                  else property.setValue(value);
                });
              }
            }
            const checked = new UndoWrapper(new PeriodCollection(properties),
              new Text(`change drawing visibility on ${label}`, `修改绘图在 ${label} 的可见性`), model);
            return definitions.createCheckablePropertyDefinition({checked}, {id:`MWDrawingVisibility${label}`,title:label});
          })]};
        }};
      }
      adapted.mwDrawingVisibility = true;
      return adapted;
    };
    if (!req?.m || req.m[887608]) throw Error('绘图可见周期适配必须在属性窗口首次加载前安装');
    win.mwDrawingVisibilityInstalled = true;
    const push = win.webpackChunktradingview.push;
    win.webpackChunktradingview.push = function(chunk) {
      if (chunk[1]?.[887608]) chunk[1][887608] = wrap(chunk[1][887608]);
      return push.call(this,chunk);
    };
  }
  return {ensure,actual,install};
})();
// Export a plain ASCII name to the licensed adapter boundary.
globalThis.MWDrawingVisibility = MWDrawingVisibilityAdapter;
