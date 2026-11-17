# OpenAPI Path Check

See which path parameters an OpenAPI operation inherits, preview the exact encoded request path, and pin it with fixtures in CI. Works locally with OpenAPI 3.0 and 3.1 JSON, with no runtime dependencies or network requests.

## Try it

Download the archive, then run the included synthetic example with Node.js 22 or later. [GitHub release](https://github.com/4onv/openapi-path-check/releases/latest)

```sh
npm install --global --offline ./4onv-openapi-path-check-0.1.0.tgz
openapi-path-check demo
```

In the example, GET inherits the path-level `document` parameter and PATCH overrides its style with `label`. Here are the two request paths for `north team` and `a/b?x#y`.

```text
GET    /workspaces/north%20team/documents/a%2Fb%3Fx%23y
PATCH  /workspaces/north%20team/documents/.a%2Fb%3Fx%23y
```

The CLI prints the declaration and resolved definition of each effective path parameter. On an override, it also identifies the inherited declaration that the operation replaced.

## Audit, render, and check

```sh
openapi-path-check audit openapi.json
openapi-path-check render openapi.json GET '/workspaces/{workspace}/documents/{document}' values.json
openapi-path-check check openapi.json path-cases.json --json
```

- `audit` lists operations and declaration sources. It reports missing or unused path parameters, duplicates at the same scope, broken or unsupported references, and unsupported serialization.
- `render` selects one operation and reads raw named values from a JSON object. It prints the encoded path alone, or provenance and path with `--json`.
- `check` compares paths with the expected strings in a JSON fixture array. It reports mismatches and operations that could not render.

The fixture file contains an array of named cases. This synthetic case checks that the document ID stays encoded as path data.

```json
[
  {
    "name": "Document ID stays in one path segment",
    "method": "GET",
    "template": "/workspaces/{workspace}/documents/{document}",
    "values": { "workspace": "north team", "document": "a/b?x#y" },
    "expected": "/workspaces/north%20team/documents/a%2Fb%3Fx%23y"
  }
]
```

Use `audit` to check the supported declarations and `check` to pin behavior for important inputs. Both exit 1 on findings. Invalid input or a render error exits 2. Successful commands exit 0. Fixture output may include values encoded in paths, so use synthetic values in shared CI logs.

## Scope

The checker supports `simple`, `label`, and `matrix` path styles with `explode`, including strings, booleans, numbers, and nonempty flat arrays or objects. It follows same-document JSON Pointer references for Path Items and parameters. Bundled JSON works for descriptions originally split across YAML files. External references and Path Item references with ambiguous sibling fields are reported as unsupported.

The output is a relative request path. Server variables, server URL prefixes, query strings, nested values, and parameter `content` serialization are outside the current scope. The checker focuses on effective path declarations and serialization. Use a full OpenAPI validator for other fields and schema constraints. Fixture checks exercise the renderer. Generated client, proxy, and router behavior can differ, even when the URL bytes are correct. Files are limited to 8 MiB each.

Object member order follows JavaScript's enumeration order. Use strings for identifiers that require exact decimal text or exceed JavaScript's safe integer range. Serialize raw values. An input `%2F` becomes `%252F`. The renderer rejects ambiguous leading double slashes and dot segments. Label collections follow the RFC 6570 delimiter rules shown in OpenAPI 3.1.2, including when the input document is 3.0.x. [OpenAPI serialization examples](https://spec.openapis.org/oas/v3.1.2.html#style-examples) · [RFC 6570](https://www.rfc-editor.org/rfc/rfc6570.html)

## Run from source

```sh
node bin/openapi-path-check.js demo
npm test
npm pack --ignore-scripts
npm run check:package
```

Tests cover inheritance, overrides, encoding styles and errors, the installed package, and a real loopback HTTP request that checks the exact target observed by the server.

[November 16 research and candidate comparison](docs/research-2026-11-16.md) · [MIT License](LICENSE)
