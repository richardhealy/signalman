/**
 * Keeps the documented booking requests honest.
 *
 * The README, the docs, the compose file and the screenshot script all show
 * `curl` and `grpcurl` calls with a JSON body. Twice those bodies drifted from
 * what the running stack accepts: field names the gateway rejects
 * (`skuId`, `customerId`) and SKUs the inventory service never seeded. These
 * tests read the files as published and check each body against the gateway's
 * own validator and the inventory seed.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { DEMO_STOCK } from '../../../inventory/src/holds/demo-stock';
import { parseBookingRequest } from './booking.controller';

const ROOT = join(__dirname, '..', '..', '..', '..');
const SCREENSHOT_SCRIPT = 'scripts/screenshot.mjs';

const DOCUMENTED_FILES = [
  'README.md',
  'docker-compose.yml',
  SCREENSHOT_SCRIPT,
  ...readdirSync(join(ROOT, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`),
];

interface DocumentedRequest {
  /** `file:line` where the command starts, for test names. */
  where: string;
  /** `curl` (an HTTP call) or `grpcurl` (a gRPC call). */
  tool: 'curl' | 'grpcurl';
  /** The command text from the tool name up to the body. */
  command: string;
  body: Record<string, unknown>;
}

/** Every `curl`/`grpcurl ... -d '{...}'` call in a file, with its parsed body. */
function documentedRequests(file: string): DocumentedRequest[] {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const found: DocumentedRequest[] = [];
  // From a tool name to the first -d '{...}' after it, without crossing into
  // the next command.
  const pattern = /\b(grpcurl|curl)\b((?:(?!\b(?:grpc)?curl\b)[\s\S]){0,400}?)-d '(\{[^']*\})'/g;
  for (const match of text.matchAll(pattern)) {
    const line = text.slice(0, match.index).split('\n').length;
    found.push({
      where: `${file}:${line}`,
      tool: match[1] as 'curl' | 'grpcurl',
      command: match[2],
      body: JSON.parse(match[3]) as Record<string, unknown>,
    });
  }
  return found;
}

const ALL_REQUESTS = DOCUMENTED_FILES.flatMap(documentedRequests);

/** `curl -X POST .../bookings` calls: what a reader sends to the gateway. */
const BOOKING_POSTS = ALL_REQUESTS.filter(
  (r) => r.tool === 'curl' && /\/bookings(?![\w/])/.test(r.command),
);

describe('documented booking requests', () => {
  it('finds the quick-start requests in the README and the screenshot script', () => {
    const files = new Set(BOOKING_POSTS.map((r) => r.where.split(':')[0]));
    expect(files).toContain('README.md');
    expect(files).toContain(SCREENSHOT_SCRIPT);
  });

  it.each(BOOKING_POSTS.map((r) => [r.where, r] as const))(
    'POST /bookings body at %s passes the gateway validator',
    (_where, request) => {
      expect(() => parseBookingRequest(request.body)).not.toThrow();
    },
  );

  it.each(
    ALL_REQUESTS.filter((r) => typeof r.body.sku === 'string').map(
      (r) => [r.where, r.body.sku as string] as const,
    ),
  )('request at %s names a seeded SKU (%s)', (_where, sku) => {
    expect(Object.keys(DEMO_STOCK)).toContain(sku);
  });
});

describe('overview screenshot', () => {
  const script = readFileSync(join(ROOT, SCREENSHOT_SCRIPT), 'utf8');

  it('shows the same booking request as the README quick start', () => {
    const [readmeQuickStart] = BOOKING_POSTS.filter((r) => r.where.startsWith('README.md:'));
    const [shown] = BOOKING_POSTS.filter((r) => r.where.startsWith(SCREENSHOT_SCRIPT));
    expect(shown.body).toEqual(readmeQuickStart.body);
  });

  it('only shows booking statuses the gateway returns', () => {
    const statuses = [...script.matchAll(/"status":\s*"(?:<[^>]+>)?(\w+)/g)].map((m) => m[1]);
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(['booked', 'failed']).toContain(status);
    }
  });
});
