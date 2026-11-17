import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import packageInfo from '../package.json' with { type: 'json' };

const archive = resolve(process.argv[2] ?? '4onv-openapi-path-check-' + packageInfo.version + '.tgz');
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run through npm run check:package.');
const directory = await mkdtemp(join(tmpdir(), 'openapi-path-check-package-'));

function node(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: directory, encoding: 'utf8', timeout: 45_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error ?? ''));
  return result.stdout;
}

try {
  node([npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', archive]);
  const exec = [npm, 'exec', '--offline', '--', 'openapi-path-check'];
  assert.equal(node([...exec, '--version']).trim(), packageInfo.version);
  const demo = JSON.parse(node([...exec, 'demo', '--json']));
  assert.equal(demo.synthetic, true);
  assert.equal(demo.checks.passed, 3);
  node(['--input-type=module', '--eval',
    "import { auditOpenApi, renderPath, checkCases } from '@4onv/openapi-path-check';" +
    "if (auditOpenApi({openapi:'3.1.2'}).operations.length || !renderPath || !checkCases) process.exit(1);"]);
  console.log('Offline archive install, installed CLI demo, and package exports passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
