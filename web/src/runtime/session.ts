/** Account and preference operations share the authenticated application client. */
import type {api as requestAPI} from '../api';
import {preferenceDrafts,putPreferenceDraft,failPreferenceDraft,dropPreferenceDraft} from '../advanced/localDrafts';
export function sessionRuntime({mobile,api,rawAPI,draftsChanged}:{mobile:boolean;api:typeof requestAPI;rawAPI:typeof requestAPI;draftsChanged:()=>void}) {
 return async (kind:string,q:any) => {
  if(kind==='account-password') {
   if(!q || typeof q.current_password!=='string' || typeof q.new_password!=='string' || [...q.current_password].length>512 || [...q.new_password].length>512)throw Error('无效密码请求');
   return api('/account/password',q);
  }
  if(kind==='style-template-name') {
   const value=mobile?'':prompt('图表样式模板名称（同名将覆盖）','我的样式')?.trim() || '';
   if(value.length>128)throw Error('模板名称不能超过128字');return value;
  }
  if(kind==='symbol-flags') {
   if(!q || !['read','save'].includes(q.op) || JSON.stringify(q).length>1_100_000)throw Error('收藏请求不允许');
   if(q.op==='read')return (await api<any[]>('/advanced-charts/preferences')).find(row=>row.kind==='setting' && row.name==='mw.symbol-flags.v1' && !row.tool) || null;
   if(mobile || q.args?.kind!=='setting' || q.args?.name!=='mw.symbol-flags.v1' || q.args?.tool)throw Error('收藏保存请求不允许');
   return rawAPI('/advanced-charts/preferences/save',q.args);
  }
  if(kind!=='preferences' || !q || (mobile && q.op!=='read') || !['read','save','delete','draftWrite','draftDrop','draftCheck','draftFailed'].includes(q.op) || JSON.stringify(q).length>1_100_000)throw Error('设置请求不允许');
  if(q.op==='delete' && !/^[a-f0-9]{64}$/.test(q.args?.id || ''))throw Error('无效设置标识');
  if(q.op==='draftCheck')return preferenceDrafts().some(draft=>draft.storageKey===q.args.storageKey && draft.version===q.args.version && draft.key===q.args.key);
  if(['draftWrite','draftDrop','draftFailed'].includes(q.op)){
   if(q.op==='draftWrite')putPreferenceDraft(q.args);else if(q.op==='draftFailed')failPreferenceDraft(q.args);else dropPreferenceDraft(q.args);
   draftsChanged();return {ok:true};
  }
  if(q.op==='read')return api('/advanced-charts/preferences');
  return rawAPI(q.op==='save'?'/advanced-charts/preferences/save':'/advanced-charts/preferences/'+q.args.id+'/delete',q.args);
 };
}
