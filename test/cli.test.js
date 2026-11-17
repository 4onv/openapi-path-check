import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const path = relative => fileURLToPath(new URL(relative, import.meta.url));
const cli = path('../bin/openapi-path-check.js');
const spec = path('../examples/synthetic-openapi.json');
const fixtures = path('../examples/synthetic-cases.json');
const values = path('../examples/synthetic-values.json');
const template = '/workspaces/{workspace}/documents/{document}';
const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8', timeout: 10_000, windowsHide: true,
});
async function withFile(content, callback) {
  const root = await mkdtemp(join(tmpdir(), 'openapi-path-check-'));
  try {
    const file = join(root, 'test file.json');
    await writeFile(file, content);
    await callback(file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('CLI demo labels synthetic data and passes its bundled fixtures', () => {
  const human = run('demo');
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Synthetic OpenAPI example/);
  assert.match(human.stdout, /3\/3 fixtures passed/);
  assert.ok(human.stdout.includes('/workspaces/north%20team/documents/.a%2Fb%3Fx%23y'));
  const json = run('demo', '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).synthetic, true);
});

test('CLI audit and render produce readable provenance and a pure request path', () => {
  const output = run('audit', spec, '--json');
  assert.equal(output.status, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).operations[1].parameters[1].scope, 'operation');
  const result = run('render', spec, 'PATCH', template, values);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '/workspaces/north%20team/documents/.a%2Fb%3Fx%23y');
});

test('CLI returns 1 for a fixture regression and 0 for a passing suite', async () => {
  const good = run('check', spec, fixtures, '--json');
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).passed, 3);
  const data = JSON.parse(await readFile(fixtures));
  data[0].expected = '/wrong';
  await withFile(JSON.stringify(data), file => {
    const result = run('check', spec, file, '--json');
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).results[0].status, 'mismatch');
  });
});

test('CLI distinguishes structural diagnostics from unreadable inputs', async () => {
  await withFile('{"openapi":"3.0.3","paths":{"/v/{id}":{"get":{}}}}', file => {
    const result = run('audit', file, '--json');
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).diagnostics[0].code, 'missing-path-parameter');
  });
  await withFile(Uint8Array.of(0xfe, 0xff), file => {
    const result = run('audit', file);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /valid UTF-8 JSON/);
  });
  assert.equal(run('audit', spec, '--unknown').status, 2);
});
