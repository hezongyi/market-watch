// Read-only probe: never create/edit/trigger/ack a real user's alert.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {request} = require('@playwright/test');
const task = 'mw-managed-live-rollover-20261113';
const origin = 'https://127.0.0.1:18447';
const output = process.env.MW_ALERT_RUNTIME_OUTPUT || '/tmp/mw-alert-readiness-20261116/runtime';
(async () => {
  fs.mkdirSync(output, {recursive:true});
  const api = await request.newContext({baseURL:origin, ignoreHTTPSErrors:true});
  try {
    const login = await api.post('/api/login', {data:{password:JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.local/share/market-watch-docker/previews',task,'credentials.json'))).login_password}});
    assert(login.ok(), 'task login');
    const hr = await api.get('/api/health'), rr = await api.get('/api/chart-alerts');
    assert(hr.ok() && rr.ok(), 'health and rules readable');
    const health = await hr.json(), rules = await rr.json(), now = health.time;
    const loop = health.chart_alerts.loop;
    const proof = {at:new Date().toISOString(), host:'Ubuntu local Docker', project:task,
      loop:{state:loop.state, heartbeat_at:loop.heartbeat_at, last_success_at:loop.last_success_at},
      notifications:health.notification_runtime.map(r=>({role:r.role,state:r.state})),
      rules:rules.map(r=>({status:r.status,state:r.execution?.state,reason:r.execution?.reason_code,taken_over_at:r.execution?.taken_over_at,last_checked_at:r.execution?.last_checked_at,last_evaluated_at:r.execution?.last_evaluated_at}))};
    fs.writeFileSync(path.join(output,'probe.json'),JSON.stringify(proof,null,2));
    assert(['idle','running','waiting_input','ready'].includes(loop.state), 'alert execution service must be running');
    assert(now - loop.heartbeat_at < 60000, 'monitor heartbeat fresh');
    for (const role of health.notification_runtime) assert(['idle','running','success','waiting_input'].includes(role.state), 'notification role healthy: '+role.role);
    for (const r of rules.filter(r=>r.status==='active' && r.execution)) {
      assert(r.execution.taken_over_at, 'enabled rule must be taken over');
      assert(now - r.execution.last_checked_at < 60000, 'individual rule checked recently');
      assert.notEqual(r.execution.reason_code,'awaiting_worker');
    }
    console.log('PASS task monitor heartbeat, rule takeover/checks and notification runtime');
  } finally {await api.dispose();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
