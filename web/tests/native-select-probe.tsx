// Browser seam for the real pinned native disclosure inside its real popup.
// This tests shared control semantics; full business-flow acceptance is separate.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { NativeInput, NativeSelect, NativeUiContext } from "../src/market-data/NativeControls";

declare global { interface Window { mountSelectProbe: (node: HTMLElement, ui: any) => void } }

function Form() {
  const [version, setVersion]=useState("");
  const [mapping, setMapping]=useState("");
  const [target, setTarget]=useState("");
  const [busy, setBusy]=useState(false);
  const [submitted, setSubmitted]=useState(0);
  return <form onSubmit={event=>{event.preventDefault();setSubmitted(n=>n+1);}}>
    <fieldset disabled={busy}>
      <label>新历史基线<NativeSelect required value={version} onChange={e=>setVersion(e.target.value)}>
        <option value="">选择已发布固定M1版本</option><option value="published-v1">固定版本一</option><option value="published-v2">固定版本二</option>
      </NativeSelect></label>
      <label>实时映射版本<NativeSelect required disabled={!version} value={mapping} onChange={e=>setMapping(e.target.value)}>
        <option value="">选择已审核映射</option><option value="mapping-v1">已审核映射一</option>
      </NativeSelect></label>
      <label>目标准确品种<NativeSelect required value={target} onChange={e=>setTarget(e.target.value)}>
        <option value="">选择品种</option><option value="EUR_USD">EUR_USD</option><option value="USD_JPY">USD_JPY</option>
      </NativeSelect></label>
      <label>校验说明<NativeInput required aria-label="校验说明" /></label>
      <button type="submit">验证提交</button>
    </fieldset>
    <button type="button" onClick={()=>setBusy(b=>!b)}>切换忙碌</button>
    <output>{JSON.stringify({version,mapping,target,submitted})}</output>
  </form>;
}
window.mountSelectProbe=(node,ui)=>createRoot(node).render(<NativeUiContext value={ui}><Form/></NativeUiContext>);
