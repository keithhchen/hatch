const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2], checks = [];
function check(name, fn) {
  try { fn(); checks.push({name, status: 'passed'}); }
  catch (e) { checks.push({name, status: 'failed', error: String(e)}); }
}
function denied(fn) {
  try { fn(); } catch (e) { if (['EACCES', 'EPERM'].includes(e.code)) return; throw e; }
  throw Error('operation was allowed');
}
check('environment credentials absent', () => {
  const forbidden = new Set(['HATCH_PROBE_PASSWORD', 'HATCH_PROBE_ENV_CANARY', 'GITHUB_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS']);
  if (Object.keys(process.env).some(k => forbidden.has(k.toUpperCase()))) throw Error('unexpected environment key (values withheld)');
});
check('workspace read/write', () => {
  const p = path.join(root, 'workspace', 'node-marker');
  fs.writeFileSync(p, 'node-ok');
  if (fs.readFileSync(p, 'utf8') !== 'node-ok') throw Error('marker mismatch');
});
for (const dir of ['runtime', 'attachments']) {
  const p = path.join(root, dir, 'probe-canary.txt');
  check(dir + ' read', () => { if (fs.readFileSync(p, 'utf8') !== 'readonly') throw Error('canary mismatch'); });
  check(dir + ' write denied', () => denied(() => fs.writeFileSync(p, 'ESCAPE')));
}
check('ungranted read denied', () => denied(() => fs.readFileSync(path.join(root, 'ungranted', 'secret.txt'))));
check('ungranted write denied', () => denied(() => fs.writeFileSync(path.join(root, 'ungranted', 'secret.txt'), 'ESCAPE')));
check('synthetic internal DB read denied', () => denied(() => fs.readFileSync(path.join(root, 'ungranted', 'internal.db'))));
console.log(JSON.stringify({checks}));
process.exitCode = checks.every(c => c.status === 'passed') ? 0 : 1;
