// Deterministic local fixture helpers. No default server, credentials or DB.
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function hash(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

function requirePreviewConfig() {
  const required = ['MARKET_WATCH_TEST_URL', 'MARKET_WATCH_CHART_ORIGIN',
    'MARKET_WATCH_TEST_CREDENTIALS', 'MARKET_WATCH_MOBILE_TASK',
    'MARKET_WATCH_MOBILE_ARTIFACTS'];
  for (const name of required) {
    if (!process.env[name]) throw new Error(`${name} is required for product acceptance`);
  }
  const base = new URL(process.env.MARKET_WATCH_TEST_URL);
  const chart = new URL(process.env.MARKET_WATCH_CHART_ORIGIN);
  const loopback = ['localhost', '127.0.0.1'].includes(base.hostname) &&
    ['localhost', '127.0.0.1'].includes(chart.hostname);
  if (!loopback && process.env.MARKET_WATCH_MOBILE_ACCEPTANCE_APPROVED !== '1')
    throw new Error('external acceptance requires MARKET_WATCH_MOBILE_ACCEPTANCE_APPROVED=1 after user approval');
  if (loopback && process.env.MARKET_WATCH_TEST_SELF_SIGNED !== '1')
    throw new Error('MARKET_WATCH_TEST_SELF_SIGNED=1 is required for the task preview');
  const credentials = path.resolve(process.env.MARKET_WATCH_TEST_CREDENTIALS);
  if (!fs.existsSync(credentials)) throw new Error(`credentials file is missing: ${credentials}`);
  const secret = JSON.parse(fs.readFileSync(credentials, 'utf8'));
  if (!secret.login_password) throw new Error('credentials.login_password is required');
  const artifacts = path.resolve(process.env.MARKET_WATCH_MOBILE_ARTIFACTS);
  fs.mkdirSync(artifacts, {recursive: true});
  return {base, chart, credentials, secret, artifacts, task: process.env.MARKET_WATCH_MOBILE_TASK, loopback};
}

module.exports = {canonical, hash, requirePreviewConfig};
