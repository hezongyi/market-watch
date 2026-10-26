import type {api as requestAPI} from '../api';
export function dataCenterRuntime({api,mobile,session,requests}:{api:typeof requestAPI;mobile:boolean;session:()=>string|null;requests:Map<object,Map<number,AbortController>>}) {
 return async (q:any,id:number,source:object)=>{
  const opened=session();
  if(mobile || !q || !opened || q.session!==opened || typeof q.path!=='string' || q.path.length>4000 || JSON.stringify(q).length>100000 ||
   !/^\/market-data\/(?:center|datasets|history-catalog|date-boundary|composites|tasks|versions|series|resolve|capabilities|sources|live)(?:\/[A-Za-z0-9_-]+)*(?:\?[^#]*)?$/.test(q.path) && q.path!=='/charts/provider/configure')throw Error('数据中心请求不允许');
  const controller=new AbortController();if(!requests.has(source))requests.set(source,new Map());requests.get(source)!.set(id,controller);
  try {const result=await api(q.path,q.body,controller.signal);if(session()!==opened)throw Error('数据中心已关闭');return result;}
  finally {requests.get(source)?.delete(id);}
 };
}
