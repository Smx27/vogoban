#!/usr/bin/env node
/**
 * OpenAPI-driven API client generation for customer-portal.
 *
 * The path constants this portal calls are read out of the OpenAPI document that
 * platform-gateway publishes from its running service, so renaming a gateway route
 * breaks this repository's build instead of breaking the portal at runtime.
 *
 * Dependency-free on purpose: node:fs, node:path and node:url only.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const documentPath = resolve(
  repositoryRoot,
  '../platform-gateway/openapi/platform-gateway.openapi.yaml',
);
const outputPath = resolve(repositoryRoot, 'src/app/api/gateway-api.paths.ts');

const httpMethods = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']);

/**
 * Reads the operations published under the top-level `paths` mapping, in document
 * order, as `{ path, methods }` pairs.
 */
function readOperations(yaml) {
  const lines = yaml.split(/\r?\n/);
  const pathsIndex = lines.findIndex((line) => /^paths:\s*$/.test(line));

  if (pathsIndex === -1) {
    throw new Error(`${documentPath} has no top-level "paths" mapping.`);
  }

  const operations = [];
  let pathIndentation;
  let current;

  for (const line of lines.slice(pathsIndex + 1)) {
    const text = line.trim();

    if (text === '' || text.startsWith('#')) {
      continue;
    }

    const indentation = line.length - line.trimStart().length;

    if (indentation === 0) {
      break;
    }

    if (pathIndentation === undefined) {
      pathIndentation = indentation;
    }

    if (indentation === pathIndentation) {
      const key = /^([^:]+):\s*$/.exec(text);

      if (key !== null) {
        current = { path: key[1].replace(/^["']|["']$/g, '').trim(), methods: [] };
        operations.push(current);
      }

      continue;
    }

    const method = /^([a-z]+):/.exec(text);

    if (current !== undefined && method !== null && httpMethods.has(method[1])) {
      current.methods.push(method[1].toUpperCase());
    }
  }

  return operations.filter(
    (operation) => operation.path.startsWith('/') && operation.methods.length > 0,
  );
}

function capitalise(word) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Turns a path into a camelCase property name. A parameter segment becomes `By<Name>`,
 * so `/api/Customers/{id}/orders` reads `apiCustomersByIdOrders`. Two paths that differ
 * only in case collide on purpose here; the later one keeps its HTTP method as a suffix.
 */
function keyFor(path, method, usedKeys) {
  const base = path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const parameter = /^\{(.+)\}$/.exec(segment);

      if (parameter !== null) {
        return `By${capitalise(parameter[1])}`;
      }

      return segment
        .split(/[^A-Za-z0-9]+/)
        .filter((word) => word.length > 0)
        .map(capitalise)
        .join('');
    })
    .join('');

  const camelCase = base.charAt(0).toLowerCase() + base.slice(1);
  let key = camelCase;
  let suffix = 2;

  while (usedKeys.has(key)) {
    key = `${camelCase}${capitalise(method)}${suffix === 2 ? '' : suffix}`;
    suffix += 1;
  }

  usedKeys.add(key);

  return key;
}

function render(operations) {
  const usedKeys = new Set();
  const entries = operations.map((operation) => {
    const comment = operation.methods.join(', ');
    return `  ${keyFor(operation.path, operation.methods[0], usedKeys)}: '${operation.path}', // ${comment}`;
  });

  return `/**
 * Gateway paths generated from ../platform-gateway/openapi/platform-gateway.openapi.yaml
 * by scripts/generate-api-client.mjs (npm run generate:api). Do not edit by hand.
 *
 * Every gateway URL this portal calls is assembled from these constants, so the portal
 * cannot drift from the contract the gateway publishes.
 */

export const GATEWAY_PATHS = {
${entries.join('\n')}
} as const;

export type GatewayPath = (typeof GATEWAY_PATHS)[keyof typeof GATEWAY_PATHS];

const placeholder = /\\{([^}]+)\\}/g;

/**
 * Substitutes the \`{name}\` placeholders of a generated gateway path with the supplied
 * values, so no caller ever assembles a gateway URL from a string literal.
 */
export function buildPath(path: GatewayPath, values: Record<string, string> = {}): string {
  return path.replace(placeholder, (match: string, name: string) => {
    const value = values[name];

    if (value === undefined) {
      throw new Error(\`No value supplied for \${match} in gateway path \${path}.\`);
    }

    return encodeURIComponent(value);
  });
}
`;
}

const operations = readOperations(readFileSync(documentPath, 'utf8'));

if (operations.length === 0) {
  throw new Error(`${documentPath} publishes no operations; refusing to write an empty client.`);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, render(operations));

console.log(
  `customer-portal -> ${operations.length} gateway path(s) generated into ${outputPath.replace(`${repositoryRoot}/`, '')}.`,
);

for (const operation of operations) {
  console.log(`  ${operation.methods.join(',').padEnd(5)} ${operation.path}`);
}
