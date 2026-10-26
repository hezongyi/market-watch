import type {api as requestAPI} from '../api';
import {chartAlertUiRequest,type AlertUiScope} from '../advanced/chartAlertUiApi';
/** Native drawing edits retain the saved object identity and current workspace scope. */
export function alertRuntime({api,mobile,scope}:{api:typeof requestAPI;mobile:boolean;scope:()=>AlertUiScope}) {
 return async (kind:string,q:any,valid:()=>boolean)=>{
  const current=scope();
  if(kind==='chart-alert-ui-rpc')return chartAlertUiRequest(q,current,valid,(path,body)=>{
   if(mobile && body!==undefined && path!=='/chart-alerts/capabilities' && !path.endsWith('/ack'))throw Error('当前图表只读');
   return api(path,body);
  });
  if(mobile || !q || JSON.stringify(q).length>20_000 || !['geometry','edit','read','lifecycle'].includes(q.op))throw Error('无效告警请求');
  if(q.op==='geometry')return api('/chart-alerts/geometry',q.args);
  if(typeof q.alert_id!=='string' || !/^[a-f0-9-]{36}$/.test(q.alert_id))throw Error('无效告警请求');
  const row=await api(`/chart-alerts/${q.alert_id}`);
  if(!valid())throw Error('告警工作区已切换');
  if(q.op==='read')return row;
  const a=row.config.association;
  if(!a || q.workspace_id!==current.workspace_id || a.workspace_id!==current.workspace_id || a.object_id!==q.object_id || a.chart_id!==q.chart_id)throw Error('告警图表关联已改变');
  if(q.op==='lifecycle' && (q.action==='drawing_deleted' || q.action==='archive' && !a.object_kind && row.config.condition.left.kind==='price' && row.config.condition.right?.kind==='constant'))
   return api(`/chart-alerts/${q.alert_id}/lifecycle`,{version:q.version,control_revision:q.control_revision,request_id:q.request_id,action:q.action});
  if(q.op==='edit' && q.line && a.object_kind==='drawing')return api(`/chart-alerts/${q.alert_id}/edit`,{version:q.version,config:{...row.config,condition:{...row.config.condition,right:{kind:'line',line:q.line}},association:{...a,generation:q.generation}}});
  throw Error('不允许的画线告警操作');
 };
}
