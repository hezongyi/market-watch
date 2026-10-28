import {spawnSync} from 'node:child_process';
const checks=['single-app-routing.cjs','advanced-native-save-race.cjs','notifications-runtime.cjs','notifications-persistence.cjs','native-notification-header-ready.cjs',
 'advanced-market-stream.cjs','advanced-historical-reset.cjs','advanced-bar-range-lifecycle.cjs','chart-stream-fallback.cjs',
 'advanced-market-request-scheduling.cjs','advanced-inflight-cancellation.cjs','advanced-history-admission.cjs',
 'advanced-provider-request-lifetime.cjs','advanced-native-workspaces.cjs','advanced-preferences.cjs','advanced-preferences-conflict.cjs',
 'chart-alert-ui-rpc.test.cjs','chart-alerts-bridge.test.cjs','alert-price-edit.test.cjs','alert-editing.browser.cjs','native-alert-price-lines.browser.cjs','alert-price-drag.browser.cjs'];
if(!process.argv.includes('--unit'))checks.push('single-frontend.browser.cjs');
for(const file of checks){const result=spawnSync(process.execPath,['tests/'+file],{stdio:'inherit'});if(result.status!==0)process.exit(result.status || 1);}
