import assert from 'node:assert/strict';
import { get, createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { auditOpenApi, checkCases, renderPath } from '../src/path-check.js';

const sample = JSON.parse(await readFile(new URL('../examples/synthetic-openapi.json', import.meta.url)));
const cases = JSON.parse(await readFile(new URL('../examples/synthetic-cases.json', import.meta.url)));
const param = (name, options = {}) => ({ name, in: 'path', required: true, schema: {}, ...options });
const specFor = (item, template = '/v/{id}') => ({ openapi: '3.0.3', paths: { [template]: item } });

test('synthetic fixtures prove inherited, overridden, and exploded path serialization', () => {
  const audit = auditOpenApi(sample);
  assert.deepEqual(audit.diagnostics, []);
  assert.equal(audit.operations.length, 3);
  const [get, patch] = audit.operations;
  assert.deepEqual(get.parameters.map(p => p.scope), ['path-item', 'path-item']);
  assert.deepEqual(patch.parameters.map(p => p.scope), ['path-item', 'operation']);
  assert.equal(get.parameters[1].definedAt, '#/components/parameters/document');
  assert.equal(patch.parameters[1].definedAt, '#/components/parameters/documentLabel');
  assert.equal(patch.parameters[1].overriddenAt, get.parameters[1].declaredAt);
  const result = checkCases(sample, cases);
  assert.equal(result.passed, 3);
  assert.equal(result.results[1].actual, '/workspaces/north%20team/documents/.a%2Fb%3Fx%23y');
});

test('a query parameter sharing the template name does not override the path parameter', () => {
  const spec = specFor({ parameters: [param('id')], get: { parameters: [param('id', { in: 'query' })] } });
  const result = renderPath(spec, 'get', '/v/{id}', { id: 0 });
  assert.equal(result.path, '/v/0');
  assert.equal(result.parameters[0].scope, 'path-item');
  assert.equal(result.parameters[0].overriddenAt, null);
});

test('same-document path references and escaped JSON Pointer segments retain their source', () => {
  const spec = { openapi: '3.1.2', paths: { '/v/{id}': { $ref: '#/components/pathItems/shared' } },
    components: { pathItems: { shared: { parameters: [{ $ref: '#/components/parameters/a~1b~0%20c' }], get: {} } },
      parameters: { 'a/b~ c': param('id') } } };
  const { parameters, path } = renderPath(spec, 'GET', '/v/{id}', { id: 'café' });
  assert.equal(parameters[0].declaredAt, '#/components/pathItems/shared/parameters/0');
  assert.equal(parameters[0].definedAt, '#/components/parameters/a~1b~0 c');
  assert.equal(path, '/v/caf%C3%A9');
});

test('unresolved references, cycles, inherited-list duplicates and placeholder gaps surface as diagnostics', () => {
  const spec = { openapi: '3.1.2', paths: {
    '/external': { $ref: 'https://example.invalid/path.json' },
    '/v/{id}': { parameters: [param('id'), param('id')], get: {} },
    '/w/{id}': { get: {}, post: { parameters: [param('id')] } },
    '/cycle': { $ref: '#/paths/~1cycle' },
    '/missing': { get: { parameters: [{ $ref: '#/components/missing' }] } },
    '/mixed': { $ref: '#/paths/~1cycle', get: {} },
  } };
  const result = auditOpenApi(spec);
  assert.deepEqual(result.diagnostics.map(x => x.code), ['external-reference', 'duplicate-path-parameter',
    'missing-path-parameter', 'reference-cycle', 'missing-reference', 'path-ref-with-siblings']);
  assert.equal(result.operations[0].method, 'POST');
  assert.equal(result.diagnostics[2].method, 'GET');
});

test('malformed, optional and unsupported declarations fail with specific codes', () => {
  const specs = [
    [specFor({ get: {} }, '/unterminated/{id'), 'invalid-template'],
    [specFor({ get: {} }, '/%{id}AB'), 'invalid-template'],
    [specFor({ get: { parameters: [param('other')] } }), 'unused-path-parameter'],
    [specFor({ get: { parameters: [param('id', { required: false })] } }), 'path-parameter-not-required'],
    [specFor({ get: { parameters: [param('id', { style: 'form' })] } }), 'unsupported-parameter-style'],
    [specFor({ get: { parameters: [param('id', { content: {} })] } }), 'unsupported-parameter-content'],
    [specFor({ get: { parameters: [param('id', { schema: null })] } }), 'missing-parameter-schema'],
  ];
  for (const [spec, code] of specs) assert.equal(auditOpenApi(spec).diagnostics[0].code, code);
  assert.throws(() => auditOpenApi({ swagger: '2.0' }), { code: 'unsupported-openapi' });
});

test('all path styles and explode combinations handle primitive, array and object inputs', () => {
  const values = ['green', ['a+b', 'x,y'], { 'a=b': true, q: -2 }];
  const combinations = [
    ['simple', false, ['green', 'a%2Bb,x%2Cy', 'a%3Db,true,q,-2']],
    ['simple', true, ['green', 'a%2Bb,x%2Cy', 'a%3Db=true,q=-2']],
    ['label', false, ['.green', '.a%2Bb,x%2Cy', '.a%3Db,true,q,-2']],
    ['label', true, ['.green', '.a%2Bb.x%2Cy', '.a%3Db=true.q=-2']],
    ['matrix', false, [';id=green', ';id=a%2Bb,x%2Cy', ';id=a%3Db,true,q,-2']],
    ['matrix', true, [';id=green', ';id=a%2Bb;id=x%2Cy', ';a%3Db=true;q=-2']],
  ];
  for (const [style, explode, expected] of combinations) {
    const spec = specFor({ get: { parameters: [param('id', { style, explode })] } });
    assert.deepEqual(values.map(id => renderPath(spec, 'GET', '/v/{id}', { id }).path),
      expected.map(path => '/v/' + path));
  }
  const matrix = specFor({ get: { parameters: [param('id', { style: 'matrix', explode: true })] } });
  assert.equal(renderPath(matrix, 'GET', '/v/{id}', { id: '' }).path, '/v/;id');
  assert.equal(renderPath(matrix, 'GET', '/v/{id}', { id: { a: '' } }).path, '/v/;a');
});

test('path literals and repeated names are preserved while reserved and UTF-8 bytes are encoded once', () => {
  const template = '/v%31/{id}/suffix:{id}';
  const spec = specFor({ get: { parameters: [param('id')] } }, template);
  const result = renderPath(spec, 'GET', template, { id: "a %2F/?#%!'()*雪" });
  const part = 'a%20%252F%2F%3F%23%25%21%27%28%29%2A%E9%9B%AA';
  assert.equal(result.path, '/v%31/' + part + '/suffix:' + part);
});

test('wrong values, methods and navigational path segments produce controlled errors', () => {
  const spec = specFor({ get: { parameters: [param('id')] } });
  const render = values => renderPath(spec, 'GET', '/v/{id}', values);
  assert.throws(() => render({}), { code: 'missing-value' });
  assert.throws(() => render({ id: false, query: true }), { code: 'unused-value' });
  assert.throws(() => render({ id: [] }), { code: 'empty-collection' });
  assert.throws(() => render({ id: [[1]] }), { code: 'unsupported-value' });
  assert.throws(() => render({ id: '\uD800' }), { code: 'invalid-unicode' });
  assert.throws(() => render({ id: '..' }), { code: 'unsafe-rendered-path' });
  assert.throws(() => renderPath(spec, 'CONNECT', '/v/{id}', { id: 1 }), { code: 'invalid-method' });
  assert.throws(() => renderPath(spec, 'PATCH', '/v/{id}', { id: 1 }), { code: 'operation-not-found' });
});

test('fixture mismatches and operation errors are independent, and malformed suites can fail early', () => {
  const result = checkCases(sample, [cases[0], { ...cases[1], expected: '/wrong' },
    { ...cases[2], method: 'PUT' }]);
  assert.equal(result.passed, 1);
  assert.deepEqual(result.results.map(x => x.status), ['pass', 'mismatch', 'error']);
  assert.equal(result.results[2].code, 'operation-not-found');
  assert.throws(() => checkCases(sample, [cases[0], cases[0]]), { code: 'invalid-case' });
});

test('HTTP loopback receives the exact path with separators and query markers encoded as data', async () => {
  const expected = '/v/r%2Fd%3Fq%3Dx%23f%20%25';
  const spec = specFor({ get: { parameters: [param('id')] } });
  const { path } = renderPath(spec, 'GET', '/v/{id}', { id: 'r/d?q=x#f %' });
  const server = createServer((request, response) => response.end(request.url));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const seen = await new Promise((resolve, reject) => {
      get({ host: '127.0.0.1', port: server.address().port, path }, async response => {
        try {
          const chunks = [];
          for await (const chunk of response) chunks.push(chunk);
          resolve(Buffer.concat(chunks).toString());
        } catch (error) {
          reject(error);
        }
      }).on('error', reject);
    });
    assert.equal(seen, expected);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
