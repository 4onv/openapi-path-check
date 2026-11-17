const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const styles = new Set(['simple', 'label', 'matrix']);
const locations = new Set(['path', 'query', 'header', 'cookie']);
const placeholder = /\{([^{}\/\s?#\\]+)\}/gu;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => isObject(object) && Object.hasOwn(object, key);
const pointerToken = key => key.replaceAll('~', '~0').replaceAll('/', '~1');

export class PathCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PathCheckError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PathCheckError(code, message);
}

function pathsObject(spec) {
  if (!isObject(spec) || typeof spec.openapi !== 'string' || !/^3\.[01]\.\d+$/u.test(spec.openapi)) {
    fail('unsupported-openapi', 'Expected an OpenAPI 3.0.x or 3.1.x JSON document.');
  }
  if (spec.paths === undefined && spec.openapi.startsWith('3.1.')) return {};
  if (!isObject(spec.paths)) fail('invalid-paths', 'Expected an OpenAPI paths object.');
  return spec.paths;
}

function localTarget(spec, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) {
    fail('external-reference', 'References must point into this same JSON document.');
  }
  let pointer;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    fail('invalid-reference', 'A reference contains an invalid percent escape.');
  }
  if (!pointer.startsWith('/') || /~(?![01])/u.test(pointer)) {
    fail('invalid-reference', 'Expected a local JSON Pointer reference.');
  }
  let target = spec;
  for (const part of pointer.slice(1).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    const arrayIndex = Array.isArray(target) && /^(?:0|[1-9][0-9]*)$/u.test(key) && Number(key) < target.length;
    if (!arrayIndex && !own(target, key)) fail('missing-reference', 'A local JSON Pointer target is missing.');
    target = target[key];
  }
  return { target, pointer };
}

function resolveObject(spec, object, at, kind) {
  const trail = new Set();
  while (own(object, '$ref')) {
    if (kind === 'Path Item' && Object.keys(object).some(key => key !== '$ref' && !key.startsWith('x-'))) {
      fail('path-ref-with-siblings', 'A referenced Path Item has sibling fields with ambiguous merge semantics.');
    }
    const { target, pointer } = localTarget(spec, object.$ref);
    if (trail.has(pointer)) fail('reference-cycle', 'A local reference is cyclic.');
    if (trail.size === 64) fail('reference-depth', 'A local reference exceeds 64 hops.');
    trail.add(pointer);
    object = target;
    at = '#' + pointer;
  }
  if (!isObject(object)) fail('invalid-object', 'Expected an object for ' + kind + '.');
  return { object, at };
}

function fromList(spec, list, scope, at) {
  const entries = new Map();
  if (list === undefined) return entries;
  if (!Array.isArray(list)) fail('invalid-parameters', scope + ' parameters must be an array.');
  for (const [index, entry] of list.entries()) {
    const declaredAt = at + '/parameters/' + index;
    const { object: value, at: definedAt } = resolveObject(spec, entry, declaredAt, 'Parameter');
    if (typeof value.name !== 'string' || !value.name || !locations.has(value.in)) {
      fail('invalid-parameter-identity', 'A parameter needs a name and a recognized location.');
    }
    if (value.in !== 'path') continue;
    if (entries.has(value.name)) fail('duplicate-path-parameter', 'Duplicate ' + scope + ' path parameter ' + value.name + '.');
    entries.set(value.name, { value, scope, declaredAt, definedAt });
  }
  return entries;
}

function templateNames(template) {
  if (typeof template !== 'string' || !template.startsWith('/') || template.startsWith('//')) {
    fail('invalid-template', 'Expected a path template starting with one slash.');
  }
  const names = new Set();
  const literal = template.replace(placeholder, (_, name) => {
    names.add(name);
    return '~';
  });
  if (!/^[a-zA-Z0-9._~!$&'()*+,;=:@%\/-]*$/u.test(literal) ||
      /%(?![0-9a-f]{2})/iu.test(literal)) {
    fail('invalid-template', 'A path template contains malformed braces, characters or percent escapes.');
  }
  return names;
}

function describe(definition, overridden) {
  const { value, scope, declaredAt, definedAt } = definition;
  const name = value.name;
  if (value.required !== true) fail('path-parameter-not-required', 'Path parameter ' + name + ' must have required: true.');
  if (own(value, 'content')) fail('unsupported-parameter-content', 'Path parameter ' + name + ' uses content serialization.');
  if (!isObject(value.schema) && typeof value.schema !== 'boolean') {
    fail('missing-parameter-schema', 'Path parameter ' + name + ' needs a schema.');
  }
  const style = own(value, 'style') ? value.style : 'simple';
  const explode = own(value, 'explode') ? value.explode : false;
  if (!styles.has(style) || typeof explode !== 'boolean') {
    fail('unsupported-parameter-style', 'Path parameter ' + name + ' needs simple, label or matrix style and a boolean explode.');
  }
  return { name, scope, declaredAt, definedAt, style, explode, overriddenAt: overridden?.declaredAt ?? null };
}

function pathItem(spec, paths, template) {
  const names = templateNames(template);
  if (!own(paths, template)) fail('path-not-found', 'The path template does not exist in this document.');
  const { object, at } = resolveObject(spec, paths[template], '#/paths/' + pointerToken(template), 'Path Item');
  const inherited = fromList(spec, object.parameters, 'path-item', at);
  return { object, at, names, inherited };
}

function operation(spec, item, method, template) {
  if (!own(item.object, method)) fail('operation-not-found', 'The method is absent on this path template.');
  const value = item.object[method];
  if (!isObject(value)) fail('invalid-operation', 'Expected an OpenAPI Operation object.');
  const direct = fromList(spec, value.parameters, 'operation', item.at + '/' + method);
  const effective = new Map([...item.inherited, ...direct]);
  for (const name of effective.keys()) {
    if (!item.names.has(name)) fail('unused-path-parameter', 'Path parameter ' + name + ' has no template placeholder.');
  }
  const parameters = [...item.names].map(name => {
    if (!effective.has(name)) fail('missing-path-parameter', 'No effective path parameter declares {' + name + '}.');
    const overwritten = direct.has(name) ? item.inherited.get(name) : undefined;
    return describe(effective.get(name), overwritten);
  });
  return { method: method.toUpperCase(), template,
    operationId: typeof value.operationId === 'string' ? value.operationId : null, parameters };
}

export function auditOpenApi(spec) {
  const paths = pathsObject(spec);
  const operations = [];
  const diagnostics = [];
  const add = (error, template, method = null) => {
    if (!(error instanceof PathCheckError)) throw error;
    diagnostics.push({ template, method, code: error.code, message: error.message });
  };
  for (const template of Object.keys(paths)) {
    if (template.startsWith('x-')) continue;
    let item;
    try {
      item = pathItem(spec, paths, template);
    } catch (error) {
      add(error, template);
      continue;
    }
    for (const method of methods) {
      if (!own(item.object, method)) continue;
      try {
        operations.push(operation(spec, item, method, template));
      } catch (error) {
        add(error, template, method.toUpperCase());
      }
    }
  }
  return { openapi: spec.openapi, operations, diagnostics };
}

function encode(value) {
  if (!['string', 'boolean', 'number'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value))) {
    fail('unsupported-value', 'Use a string, finite number, boolean, or a nonempty flat array or object of those values.');
  }
  try {
    return encodeURIComponent(String(value)).replace(/[!'()*]/gu, character =>
      '%' + character.charCodeAt(0).toString(16).toUpperCase());
  } catch {
    fail('invalid-unicode', 'A path value contains invalid Unicode.');
  }
}

function serialize(parameter, value) {
  const { name, style, explode } = parameter;
  const scalar = !Array.isArray(value) && !isObject(value);
  const label = style === 'label';
  const matrix = style === 'matrix';
  const matrixName = matrix ? encode(name) : '';
  const member = (key, entry) => ';' + key + (entry === '' ? '' : '=' + entry);
  const prefix = label ? '.' : matrix ? ';' + matrixName + '=' : '';
  const separator = label && explode ? '.' : ',';
  if (scalar) return matrix ? member(matrixName, encode(value)) : prefix + encode(value);
  const array = Array.isArray(value);
  const items = array ? value.map(encode) : Object.entries(value).map(([key, entry]) => [encode(key), encode(entry)]);
  if (!items.length) fail('empty-collection', 'Empty arrays or objects have no supported path serialization.');
  if (!explode) {
    const joined = items.flat().join(',');
    return matrix ? member(matrixName, joined) : prefix + joined;
  }
  if (matrix) {
    return array ? items.map(item => member(matrixName, item)).join('') :
      items.map(([key, entry]) => member(key, entry)).join('');
  }
  return prefix + (array ? items : items.map(([key, entry]) => key + '=' + entry)).join(separator);
}

export function renderPath(spec, method, template, values) {
  const lower = typeof method === 'string' ? method.toLowerCase() : '';
  if (!methods.includes(lower)) fail('invalid-method', 'Expected an OpenAPI HTTP method.');
  const paths = pathsObject(spec);
  const resolved = operation(spec, pathItem(spec, paths, template), lower, template);
  if (!isObject(values)) fail('invalid-values', 'Expected an object mapping path parameter names to values.');
  const encoded = new Map(resolved.parameters.map(parameter => {
    if (!own(values, parameter.name)) fail('missing-value', 'No value provided for {' + parameter.name + '}.');
    return [parameter.name, serialize(parameter, values[parameter.name])];
  }));
  if (Object.keys(values).some(key => !encoded.has(key))) {
    fail('unused-value', 'The values object contains a name outside this operation’s path parameters.');
  }
  const path = template.replace(placeholder, (_, name) => encoded.get(name));
  if (path.startsWith('//') || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/iu.test(path)) {
    fail('unsafe-rendered-path', 'The resulting path starts with two slashes or contains a dot segment that clients may normalize.');
  }
  return { ...resolved, path };
}

export function checkCases(spec, cases) {
  pathsObject(spec);
  if (!Array.isArray(cases) || cases.length === 0 || cases.length > 1000) {
    fail('invalid-cases', 'Expected a JSON array of 1 to 1,000 path fixtures.');
  }
  const names = new Set();
  const results = cases.map((fixture, index) => {
    if (!isObject(fixture) || typeof fixture.name !== 'string' || !fixture.name.trim() ||
        names.has(fixture.name) || typeof fixture.method !== 'string' || typeof fixture.template !== 'string' ||
        !isObject(fixture.values) || typeof fixture.expected !== 'string' || !fixture.expected.startsWith('/')) {
      fail('invalid-case', 'Fixture ' + (index + 1) + ' needs a unique name, method, template, values object and expected path.');
    }
    names.add(fixture.name);
    const { name, method, template, values, expected } = fixture;
    try {
      const actual = renderPath(spec, method, template, values).path;
      return { name, status: actual === expected ? 'pass' : 'mismatch', expected, actual };
    } catch (error) {
      if (!(error instanceof PathCheckError)) throw error;
      return { name, status: 'error', code: error.code, message: error.message };
    }
  });
  return { passed: results.filter(result => result.status === 'pass').length, total: results.length, results };
}
