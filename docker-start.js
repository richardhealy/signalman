'use strict';

/**
 * Production bootstrap for the signalman monorepo.
 *
 * NestJS monorepo builds with tsc leave path aliases (@signalman/*) unresolved
 * in the compiled JS.  This shim registers them against the compiled lib output
 * (dist/libs/*) before requiring the service entry, so Node can resolve the
 * imports without needing ts-node or source files in the container.
 *
 * SERVICE_ENTRY selects which service to boot; docker-compose sets it per
 * service container.  Defaults to the gateway.
 */
const path = require('path');
const { register } = require('tsconfig-paths');

const baseUrl = __dirname;

// NestJS monorepo tsc output places each lib's source in a subdirectory named
// after the lib (e.g. dist/libs/broker/broker/src/index.js) when the lib
// depends on other libs via path aliases — tsc widens the rootDir to encompass
// all transitively-included source files.  otel/propagation/logging have no
// lib dependencies so their output is flat (dist/libs/otel/index.js).
register({
  baseUrl,
  paths: {
    '@signalman/otel': ['dist/libs/otel'],
    '@signalman/otel/*': ['dist/libs/otel/*'],
    '@signalman/propagation': ['dist/libs/propagation'],
    '@signalman/propagation/*': ['dist/libs/propagation/*'],
    '@signalman/logging': ['dist/libs/logging'],
    '@signalman/logging/*': ['dist/libs/logging/*'],
    '@signalman/interceptor': ['dist/libs/interceptor/interceptor/src'],
    '@signalman/interceptor/*': ['dist/libs/interceptor/interceptor/src/*'],
    '@signalman/outbox': ['dist/libs/outbox/outbox/src'],
    '@signalman/outbox/*': ['dist/libs/outbox/outbox/src/*'],
    '@signalman/inbox': ['dist/libs/inbox/inbox/src'],
    '@signalman/inbox/*': ['dist/libs/inbox/inbox/src/*'],
    '@signalman/broker': ['dist/libs/broker/broker/src'],
    '@signalman/broker/*': ['dist/libs/broker/broker/src/*'],
  },
});

// Services: the tsc rootDir is inferred from the full set of transitively-
// included files (including lib sources via path aliases), so the compiled
// entry lives at dist/services/<svc>/services/<svc>/src/main.js.
const entry = process.env.SERVICE_ENTRY || 'dist/services/gateway/services/gateway/src/main';
require(path.resolve(baseUrl, entry));
