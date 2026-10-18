state.finalContracts = await state.app.evaluate(async () => {
  const ensure = (value, message) => { if (!value) throw Error(message); };
  const prefix = '/api/notification-center';
  const query = 'mw75-load-590d00cf22e048d687f8f3f9665bad8b';
  let before = null, ids = [], pages = 0;
  const latency = [];
  do {
    const started = performance.now();
    const response = await fetch(prefix + '/events?limit=100&q=' + query + (before ? '&before=' + encodeURIComponent(before) : ''));
    ensure(response.ok, 'final pagination response');
    const result = await response.json();
    latency.push(Math.round(performance.now() - started));
    ids.push(...result.events.map(event => event.id));
    before = result.before;
    ensure(++pages <= 10, 'page bound');
  } while (before);
  ensure(ids.length === 1000 && new Set(ids).size === 1000, 'all 1000 final-code events exactly once');
  const filtered = await (await fetch(prefix + '/events?source=history&workspace=mw75-a&q=' + query)).json();
  ensure(filtered.events.length === 0, 'filter mismatch is empty');
  const matching = await (await fetch(prefix + '/events?source=data_center&workspace=mw75-a&severity=error&q=' + query)).json();
  ensure(matching.events.length === 100 && matching.events.every(event => event.incident.count === 1 && event.backfill && !event.attention), 'matching inert historical task events');
  const session = await (await fetch('/api/session')).json();
  const headers = {'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf};
  const baseline = await (await fetch(prefix + '/events?limit=1')).json();
  const observed = await fetch(prefix + '/observations', {method: 'POST', headers,
    body: JSON.stringify({event_id: ids[0], profile: crypto.randomUUID(), observation_id: crypto.randomUUID(), kind: 'viewed', reported_at: Date.now()})});
  ensure(observed.ok, 'view observation accepted');
  const json = await (await fetch(prefix + '/changes?after=' + encodeURIComponent(baseline.after))).json();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  let sse;
  try {
    const response = await fetch(prefix + '/stream?after=' + encodeURIComponent(baseline.after), {signal: controller.signal});
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    while (!sse) {
      const {value, done} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      for (const block of buffer.split('\n\n')) if (block.includes('event: changes')) {
        sse = JSON.parse(block.split('\n').find(line => line.startsWith('data: ')).slice(6));
        break;
      }
    }
  } finally { controller.abort(); clearTimeout(timer); }
  ensure(sse && sse.after === json.after && JSON.stringify(sse.changes) === JSON.stringify(json.changes), 'final JSON/SSE parity');
  const detail = await (await fetch(prefix + '/events/' + encodeURIComponent(ids[0]))).json();
  ensure(detail.viewed_at && !detail.handled_at && detail.evidence.synthetic_load, 'independent viewed and handled facts');
  return {database: 'preview_mw75_final', synthetic_load_only: true,
    pagination: {pages, events: ids.length, unique: new Set(ids).size, latency_ms: latency},
    filters: {mismatch_empty: true, matching_source_workspace_severity: true},
    history: {all_backfill: true, attention: false, incidents_once: true},
    json_sse_parity: {matching_cursor: true, matching_changes: true, epoch: json.epoch},
    viewed_handled_independent: true};
});
require('node:fs').writeFileSync('/tmp/mw75-playwriter/final-contracts.json', JSON.stringify(state.finalContracts, null, 2));
console.log(state.finalContracts);
