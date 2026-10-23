import {useEffect, useRef, useState} from 'react';
import {api} from '../api';
import type {PreferenceDraft} from './localDrafts';

export function PreferenceDraftDialog({drafts,onClose,onResolve}:{drafts:PreferenceDraft[];onClose:()=>void;onResolve:(draft:PreferenceDraft,action:'local'|'remote',revision:number)=>Promise<void>}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [selected,setSelected]=useState(drafts[0]?.storageKey || '');
  const [remote,setRemote]=useState<any>(undefined);
  const [refresh,setRefresh]=useState(0);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const draft=drafts.find(item=>item.storageKey===selected) || drafts[0];
  useEffect(()=>{dialog.current?.showModal();},[]);
  useEffect(()=>{
    const abort=new AbortController();setRemote(undefined);
    if(draft)void api<any[]>('/advanced-charts/preferences',undefined,abort.signal).then(rows=>{
      if(!abort.signal.aborted)setRemote(rows.find(row=>JSON.stringify([row.kind,row.name,row.tool])===draft.key) || null);
    }).catch(e=>{if(!abort.signal.aborted)setError(String(e));});
    return ()=>abort.abort();
  },[draft?.storageKey,draft?.version,refresh]);
  const show=(value:unknown)=>{try{return JSON.stringify(typeof value==='string'?JSON.parse(value):value,null,2) || '不存在';}catch{return String(value);}};
  async function resolve(action:'local'|'remote') {
    if(!draft || remote===undefined)return;
    setBusy(true);setError('');
    try {await onResolve(draft,action,remote?.revision || 0);setMessage('已处理此草稿；重新打开图表后应用保存的设置。');}
    catch(e){setError(String(e));setRefresh(value=>value+1);}
    finally{setBusy(false);}
  }
  return <dialog ref={dialog} className="preference-draft-dialog" aria-labelledby="preference-draft-title" onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
    <h2 id="preference-draft-title">处理设置草稿</h2>
    <p>自动保存遇到冲突时，本地修改会保留。核对后选择需要保留的设置。</p>
    {draft ? <>
      <label>未保存的设置<select value={draft.storageKey} disabled={busy} onChange={e=>setSelected(e.target.value)}>{drafts.map(item=><option key={item.storageKey} value={item.storageKey}>{item.name} · {new Date(item.at || 0).toLocaleString()}</option>)}</select></label>
      <div className="preference-draft-values">
        <label>本地草稿<textarea readOnly value={draft.operation==='delete'?'删除此设置':show(draft.value)}/></label>
        <label>服务器设置<textarea readOnly value={remote===undefined?'正在读取…':show(remote?.content?.value)}/></label>
      </div>
      <p>提交本地修改前会再次核对服务器版本。版本再次变化时保留草稿并停止提交。</p>
    </> : <p>当前没有未保存的设置草稿。</p>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    <footer>
      {draft && <><button disabled={busy || remote===undefined} onClick={()=>void resolve('local')}>{busy?'正在处理…':'提交本地修改'}</button><button disabled={busy || remote===undefined} onClick={()=>void resolve('remote')}>采用服务器设置</button></>}
      <button disabled={busy} onClick={onClose}>{draft?'稍后处理':'关闭'}</button>
    </footer>
  </dialog>;
}
