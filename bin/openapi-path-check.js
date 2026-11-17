#!/usr/bin/env node
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { auditOpenApi, checkCases, renderPath } from '../src/path-check.js';

const maximum = 8 * 1024 * 1024;
const usage = 'Usage: openapi-path-check audit SPEC.json [--json]\n' +
  '       openapi-path-check render SPEC.json METHOD TEMPLATE VALUES.json [--json]\n' +
  '       openapi-path-check check SPEC.json CASES.json [--json]\n' +
  '       openapi-path-check demo [--json]';

async function jsonFile(path, label) {
  let file;
  let bytes;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error(label + ' must be a regular file of up to 8 MiB.');
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error(label + ' changed size while being read.');
    bytes = buffer.subarray(0, offset);
  } catch (error) {
    if (error.code) throw new Error('Could not read ' + label + ' (' + error.code + ').');
    throw error;
  } finally {
    await file?.close();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(label + ' must contain valid UTF-8 JSON.');
  }
}

function printAudit(audit) {
  for (const operation of audit.operations) {
    console.log(operation.method + ' ' + JSON.stringify(operation.template));
    for (const parameter of operation.parameters) {
      console.log('  ' + JSON.stringify(parameter.name) + '  ' + parameter.scope + '  ' +
        parameter.style + '  explode=' + parameter.explode);
      console.log('    declared at ' + JSON.stringify(parameter.declaredAt));
      if (parameter.declaredAt !== parameter.definedAt) console.log('    resolves to ' + JSON.stringify(parameter.definedAt));
      if (parameter.overriddenAt) console.log('    overrides ' + JSON.stringify(parameter.overriddenAt));
    }
  }
  for (const item of audit.diagnostics) {
    console.log((item.method ? item.method + ' ' : '') + JSON.stringify(item.template) + '  ' +
      item.code + '  ' + JSON.stringify(item.message));
  }
  console.log(audit.operations.length + ' usable operations, ' + audit.diagnostics.length + ' diagnostics');
}

function printCases(check, showPassedPaths = false) {
  for (const fixture of check.results) {
    console.log(fixture.status.toUpperCase() + ' ' + JSON.stringify(fixture.name));
    if (fixture.status === 'mismatch') {
      console.log('  expected ' + JSON.stringify(fixture.expected));
      console.log('  actual   ' + JSON.stringify(fixture.actual));
    } else if (fixture.status === 'error') {
      console.log('  ' + fixture.code + '  ' + JSON.stringify(fixture.message));
    } else if (showPassedPaths) {
      console.log('  ' + fixture.actual);
    }
  }
  console.log(check.passed + '/' + check.total + ' fixtures passed');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' } },
  });
  const [command, specPath, third, template, valuesPath] = positionals;
  if (values.help || process.argv.length === 2) {
    console.log(usage);
    return;
  }
  if (values.version) {
    const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(packageInfo.version);
    return;
  }
  const arity = { audit: 2, render: 5, check: 3, demo: 1 };
  if (!Object.hasOwn(arity, command) || positionals.length !== arity[command]) throw new Error(usage);
  if (command === 'demo') {
    const spec = await jsonFile(new URL('../examples/synthetic-openapi.json', import.meta.url), 'demo spec');
    const cases = await jsonFile(new URL('../examples/synthetic-cases.json', import.meta.url), 'demo fixtures');
    const audit = auditOpenApi(spec);
    const checks = checkCases(spec, cases);
    if (values.json) console.log(JSON.stringify({ synthetic: true, audit, checks }, null, 2));
    else {
      console.log('Synthetic OpenAPI example');
      printAudit(audit);
      printCases(checks, true);
    }
    process.exitCode = Number(audit.diagnostics.length > 0 || checks.passed !== checks.total);
    return;
  }
  const spec = await jsonFile(specPath, 'spec');
  if (command === 'audit') {
    const audit = auditOpenApi(spec);
    if (values.json) console.log(JSON.stringify(audit, null, 2));
    else printAudit(audit);
    process.exitCode = Number(audit.diagnostics.length > 0);
  } else if (command === 'check') {
    const checks = checkCases(spec, await jsonFile(third, 'fixture file'));
    if (values.json) console.log(JSON.stringify(checks, null, 2));
    else printCases(checks);
    process.exitCode = Number(checks.passed !== checks.total);
  } else {
    const result = renderPath(spec, third, template, await jsonFile(valuesPath, 'values file'));
    console.log(values.json ? JSON.stringify(result, null, 2) : result.path);
  }
}

main().catch(error => {
  console.error(error.code?.startsWith('ERR_PARSE_ARGS') ? usage : error.message);
  process.exitCode = 2;
});
