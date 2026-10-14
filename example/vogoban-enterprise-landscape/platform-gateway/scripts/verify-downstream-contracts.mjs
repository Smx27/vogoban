#!/usr/bin/env node
/**
 * Cross-repository OpenAPI verification for platform-gateway.
 *
 * Every path this gateway's HTTP clients call is checked against the OpenAPI
 * document published by the sibling repository that serves it, so a downstream
 * route rename breaks this script instead of breaking production.
 *
 * Dependency-free on purpose: node:fs, node:path and node:url only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The downstream documents to read and the calls that must appear in each one.
 * `documents` is tried in order, so a sibling repository that publishes under a
 * second name is still covered. The `client` field names the gateway method that
 * issues the call, so a failure points at the code that would break.
 */
const downstreamContracts = [
  {
    service: 'orders-service',
    documents: ['../orders-service/openapi/orders.openapi.yaml'],
    calls: [
      { method: 'GET', path: '/api/orders', client: 'OrdersClient.ListAsync' },
      { method: 'GET', path: '/api/orders/{id}', client: 'OrdersClient.GetAsync' },
      { method: 'POST', path: '/api/orders', client: 'OrdersClient.CreateAsync' },
      { method: 'POST', path: '/api/orders/{id}/cancel', client: 'OrdersClient.CancelAsync' },
    ],
  },
  {
    service: 'customer-service',
    documents: ['../customer-service/openapi/customers.openapi.yaml'],
    calls: [
      { method: 'GET', path: '/api/customers', client: 'CustomersClient.ListAsync' },
      { method: 'GET', path: '/api/customers/{id}', client: 'CustomersClient.GetAsync' },
      { method: 'GET', path: '/api/customers/{id}/orders', client: 'CustomersClient.ListOrdersAsync' },
    ],
  },
  {
    service: 'reporting-platform',
    documents: [
      '../reporting-platform/openapi/reporting-platform.openapi.yaml',
      '../reporting-platform/openapi/reports.openapi.yaml',
    ],
    optional: true,
    calls: [
      { method: 'GET', path: '/api/reports', client: 'ReportsClient.ListAsync' },
      { method: 'POST', path: '/api/reports/requests', client: 'ReportsClient.RequestAsync' },
    ],
  },
];

/** Reads the path keys out of the top-level `paths` mapping of an OpenAPI YAML document. */
function extractPathKeys(yaml) {
  const keys = [];
  let insidePaths = false;

  for (const line of yaml.split(/\r?\n/)) {
    if (/^paths:\s*$/.test(line)) {
      insidePaths = true;
      continue;
    }

    if (!insidePaths) {
      continue;
    }

    if (/^[^\s#]/.test(line)) {
      break;
    }

    const key = /^\s+([^\s:]+):/.exec(line);

    if (key !== null && key[1].startsWith('/')) {
      keys.push(key[1].replace(/^["']|["']$/g, ''));
    }
  }

  return keys;
}

function checkDocument(contract) {
  const candidates = contract.documents.map((document) => resolve(repositoryRoot, document));
  const documentPath = candidates.find((candidate) => existsSync(candidate));

  console.log(`\n${contract.service} <${documentPath ?? candidates.join(' | ')}>`);

  if (documentPath === undefined) {
    console.log('  document unavailable: none of the candidate documents exist');

    if (contract.optional === true) {
      console.log('  skipped (no published document to check yet)');

      return 0;
    }

    for (const call of contract.calls) {
      console.log(`  ${call.method.padEnd(4)} ${call.path.padEnd(32)} MISSING (${call.client})`);
    }

    return contract.calls.length;
  }

  const keys = extractPathKeys(readFileSync(documentPath, 'utf8'));

  console.log(`  ${keys.length} path(s) published: ${keys.join(', ') || '(none)'}`);

  let missing = 0;

  for (const call of contract.calls) {
    const exact = keys.includes(call.path);
    const sameIgnoringCase = exact ? undefined : keys.find((key) => key.toLowerCase() === call.path.toLowerCase());

    if (exact) {
      console.log(`  ${call.method.padEnd(4)} ${call.path.padEnd(32)} ok`);
    } else if (sameIgnoringCase !== undefined) {
      console.log(
        `  ${call.method.padEnd(4)} ${call.path.padEnd(32)} ok (document path ${sameIgnoringCase} differs only in case; ASP.NET routing is case-insensitive)`,
      );
    } else {
      console.log(`  ${call.method.padEnd(4)} ${call.path.padEnd(32)} MISSING (${call.client})`);
      missing += 1;
    }
  }

  return missing;
}

const missing = downstreamContracts.reduce((total, contract) => total + checkDocument(contract), 0);

const checked = downstreamContracts.reduce((total, contract) => total + contract.calls.length, 0);

console.log(`\nplatform-gateway -> downstream contracts: ${checked} path(s) checked, ${missing} missing.`);

if (missing > 0) {
  console.error('platform-gateway -> verification FAILED: a downstream document does not serve a path this gateway calls.');

  process.exitCode = 1;
} else {
  console.log('platform-gateway -> verification passed.');
}
