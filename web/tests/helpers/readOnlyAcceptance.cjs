// Install before navigating. Real browser profile, workspace, settings and notice
// writes never change. Virtual preference success has a consistent shadow GET.
const crypto=require('node:crypto');
exports.readOnlyAcceptance=async function(context,report={}) {
 const rows=new Map();let initialized=false;
 const k=r=>JSON.stringify([r.kind,r.name,r.tool || '']);
 await context.route('**/api/advanced-charts/**',async route=>{
  const request=route.request(),url=new URL(request.url()),method=request.method();
  if(method==='GET' && url.pathname.endsWith('/preferences')){
   if(!initialized){const response=await route.fetch();if(!response.ok())return route.fulfill({response});for(const row of await response.json())rows.set(k(row),row);initialized=true;}
   return route.fulfill({json:[...rows.values()]});
  }
  if(['GET','HEAD','OPTIONS'].includes(method))return route.continue();
  (report.blockedWrites ||= []).push({path:url.pathname,method});
  if(url.pathname.endsWith('/preferences/migrate'))return route.fulfill({json:{ok:true}});
  if(url.pathname.endsWith('/preferences/save')){
   if(!initialized){const response=await route.fetch({method:'GET',url:url.origin+'/api/advanced-charts/preferences',postData:undefined});if(!response.ok())return route.fulfill({response});for(const row of await response.json())rows.set(k(row),row);initialized=true;}
   const body=request.postDataJSON(),key=k(body),old=rows.get(key);
   if((old?.revision || 0)!==body.revision)return route.fulfill({status:409,json:{detail:{code:'PREFERENCE_REVISION_CONFLICT',message:'设置版本冲突，草稿已保留'}}});
   const row={...body,id:old?.id || crypto.createHash('sha256').update(key).digest('hex'),revision:body.revision+1,updated_at:Date.now()};rows.set(key,row);
   return route.fulfill({json:row});
  }
  if(/\/preferences\/[^/]+\/delete$/.test(url.pathname)){
   const id=url.pathname.split('/').at(-2),body=request.postDataJSON(),entry=[...rows].find(([,row])=>row.id===id);
   if(entry && entry[1].revision!==body.revision)return route.fulfill({status:409,json:{detail:'设置版本冲突，草稿已保留'}});
   if(entry)rows.delete(entry[0]);return route.fulfill({json:{ok:true}});
  }
  return route.fulfill({status:409,json:{detail:{code:'ACCEPTANCE_READ_ONLY',message:'验收副本不保存工作区，草稿仅保留在临时浏览器'}}});
 });
 await context.route('**/api/notification-center/**',route=>{
  const request=route.request();if(['GET','HEAD','OPTIONS'].includes(request.method()))return route.continue();
  (report.blockedNoticeWrites ||= []).push(new URL(request.url()).pathname);
  const body=request.postDataJSON();return route.fulfill({json:request.url().endsWith('/intake')?{id:body.event_id,status:'accepted',recorded_at:Date.now()}:{ok:true,read:0,more:false}});
 });
};
