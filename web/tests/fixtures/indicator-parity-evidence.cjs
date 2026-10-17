// Pure acceptance predicates shared by the real-browser harnesses. Missing
// evidence fails closed; historical name/params-only records cannot pass.
const stable=value=>JSON.stringify(Object.fromEntries(Object.entries(value || {}).sort(([a],[b])=>a.localeCompare(b))));
const frame=resolution=>({1:'M1',5:'M5',15:'M15',30:'M30',60:'H1',240:'H4','1D':'D1',D:'D1','1W':'W1',W:'W1','1M':'MN',M:'MN'})[resolution];
const same=(a,b)=>a!==undefined && b!==undefined && String(a).toLowerCase()===String(b).toLowerCase();
const contains=(ranges,bar)=>ranges?.some(range=>range.start<=bar.start && range.end>=bar.end);
const itemsFor=(responses,study)=>responses.flatMap(response=>(response.indicators || [])
  .filter(item=>item.name===study.name && stable(item.params)===stable(study.params))
  .map(item=>({response,item})));

function matchAuthority(commit,responses,study,kind){
  const identity=commit?.identity;
  if(!identity || identity.algorithmVersion!==study.name+':1' || !commit.executionEvidence?.length ||
    identity.paramsFingerprint!==stable(study.params) || !commit.sourceRows?.length ||
    !Number.isFinite(commit.epochAt))return {complete:false,reason:'missing current native execution evidence'};
  const ticker=identity.main.replace(/^(MWH:|MWC:|MWP:)/,'');
  const candidates=itemsFor(responses,study).filter(({response,item})=>{
    const page=response.page || {},query=response.query || {},calculation=item.calculation || {},evidence=calculation.input_evidence || {};
    if(response.status!==200 || query.series_kind!==kind || page.series_kind && page.series_kind!==kind ||
      !same(String(query.instrument || '').replace(/^(MWH:|MWC:|MWP:)/,''),ticker) ||
      (page.timeframe || query.timeframe)!==frame(identity.period) ||
      !calculation.canonical_verified || calculation.producer!=='backend' || !calculation.algorithm ||
      !(calculation.visible_complete || calculation.status==='complete') ||
      calculation.calculation_origin!==identity.calculationStart ||
      !commit.executionEvidence.some(execution=>stable(execution)===stable(calculation)))return false;
    const snapshot=page.display_snapshot_id ?? page.provider_snapshot_id;
    if((commit.displaySnapshot ?? null)!==(snapshot ?? null))return false;
    if(kind==='composite')return same(page.revision_id,identity.fixedRevision) &&
      same(evidence.revision_id,page.revision_id) && same(commit.inputRevision,page.input_revision) &&
      same(calculation.input_revision,page.input_revision) && same(evidence.input_revision,page.input_revision) &&
      evidence.display_snapshot_id===snapshot;
    if(kind==='history')return same(evidence.history_version_id,identity.fixedRevision) &&
      same(ticker,identity.fixedRevision) && same(calculation.input_revision,0) && !snapshot;
    if(kind==='managed')return identity.fixedRevision==='published:'+evidence.publication_revision &&
      same(calculation.input_revision,evidence.publication_revision) && !snapshot;
    if(kind==='provider')return identity.fixedRevision==='provider:'+ticker &&
      same(commit.inputRevision,page.cache_revision ?? page.revision) &&
      same(calculation.input_revision,page.cache_revision ?? page.revision) &&
      same(evidence.input_revision,calculation.input_revision) && evidence.provider_snapshot_id===snapshot && !!snapshot;
    return false;
  });
  const used=new Set();
  for(const row of commit.sourceRows){
    const match=candidates.find(({response,item})=>response.sourceRows?.some(bar=>
      bar.start===row.sourceTime && (bar.chart_time ?? bar.start)===row.time &&
      contains(item.calculation.coverage,bar) && contains(item.calculation.required_coverage,bar)));
    if(!match)return {complete:false,reason:'no matching canonical execution for every submitted source row'};
    used.add(match);
  }
  const times=commit.sourceRows.map(row=>row.time);
  if(new Set(times).size<commit.coverage?.count || Math.min(...times)>commit.coverage.first ||
    Math.max(...times)<commit.coverage.last)return {complete:false,reason:'native batch lacks complete visible coverage'};
  return {complete:true,canonicalAt:Math.max(commit.epochAt,...[...used].map(({response})=>response.at)),
    executions:[...used].map(({response,item})=>({receivedAt:response.at,query:response.query,
      page:response.page,calculation:item.calculation}))};
}

function validatePreparation(config,responses,study,retainedCommit){
  const matches=itemsFor(responses,study).filter(({response})=>response.status===200);
  if(!matches.length)return {valid:false,reason:'no observed preparation execution'};
  if(matches.some(({response})=>response.query?.series_kind!==config.kind))return {valid:false,reason:'observed series kind differs from declaration'};
  const executions=matches.map(({item})=>item.calculation?.execution);
  const rows=executions.map(execution=>execution?.input_rows ??
    (Number.isInteger(execution?.calculation_steps) && Number.isInteger(execution?.checkpoint_index)
      ? execution.calculation_steps+execution.checkpoint_index : undefined));
  if(rows.some(count=>!Number.isInteger(count) || count<1 || count>config.prefixRows ||
    (config.scenario.startsWith('long-') ? count<=6000 || count>50000 : count>6000)))
    return {valid:false,reason:'missing or out-of-scenario observed prefix row count'};
  if(config.scenario==='loaded-reusable'){
    if(retainedCommit && matchAuthority(retainedCommit,responses,study,config.kind).complete)
      return {valid:true,cache:'browser-shared-result',verifiedWarmupExecution:true,observedPrefixRows:rows};
    if(executions.some(execution=>execution.result_cache!=='hit' &&
      !(execution.result_cache==='checkpoint' && execution.calculation_steps<=512)))
      return {valid:false,reason:'reusable result/checkpoint was not observed'};
  }else if(executions[0]?.result_cache!=='miss' || executions[0]?.checkpoint_index>0){
    // Retries within this operation may reuse work that its first miss created.
    return {valid:false,reason:'new specification did not begin with a result/checkpoint miss'};
  }
  return {valid:true,observedPrefixRows:rows};
}

module.exports={matchAuthority,validatePreparation};
