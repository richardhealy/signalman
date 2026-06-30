/**
 * Generates docs/screenshots/*.png via Playwright/Chromium.
 * Run: node scripts/screenshot.mjs
 */
import { chromium } from 'playwright';
import { mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots');

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ||
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();

// ── 1. Overview screenshot ────────────────────────────────────────────────────
const OVERVIEW_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>signalman overview</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #1e1e2e;
    color: #cdd6f4;
    font-family: 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-size: 13.5px;
    line-height: 1.65;
    padding: 0;
    width: 880px;
  }
  .window {
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 24px 64px rgba(0,0,0,0.6);
  }
  .titlebar {
    background: #313244;
    padding: 10px 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .dot-red    { background: #f38ba8; }
  .dot-yellow { background: #f9e2af; }
  .dot-green  { background: #a6e3a1; }
  .title { color: #a6adc8; font-size: 12px; margin-left: auto; margin-right: auto; }
  .body { padding: 24px 28px; }
  .hero { color: #cba6f7; font-size: 15px; font-weight: 600; margin-bottom: 18px; }
  .version { color: #89b4fa; }
  .stack { color: #94e2d5; font-size: 12px; margin-bottom: 24px; }
  .section { margin-bottom: 20px; }
  .section-title {
    color: #89b4fa;
    border-bottom: 1px solid #313244;
    padding-bottom: 4px;
    margin-bottom: 10px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .row { display: flex; gap: 0; margin: 2px 0; }
  .name { color: #cba6f7; min-width: 140px; }
  .arrow { color: #6c7086; min-width: 18px; }
  .desc { color: #bac2de; }
  .tag {
    display: inline-block; background: #313244; color: #89b4fa;
    font-size: 10px; border-radius: 4px; padding: 1px 6px; margin-left: 6px;
    vertical-align: middle;
  }
  .pass { color: #a6e3a1; }
  .skip { color: #f9e2af; }
  .subtle { color: #585b70; }
  .cmd { color: #fab387; }
  .url { color: #94e2d5; }
  .comment { color: #585b70; }
</style>
</head>
<body>
<div class="window">
  <div class="titlebar">
    <div class="dot dot-red"></div>
    <div class="dot dot-yellow"></div>
    <div class="dot dot-green"></div>
    <div class="title">signalman — distributed booking observability</div>
  </div>
  <div class="body">
    <div class="hero">signalman <span class="version">v1.0.0</span></div>
    <div class="stack">Stack: NestJS · TypeScript · gRPC · NATS JetStream · Postgres · OpenTelemetry</div>

    <div class="section">
      <div class="section-title">Services</div>
      <div class="row"><span class="name">gateway</span><span class="arrow">→</span><span class="desc">HTTP entry point — <span class="cmd">POST /bookings</span>, starts the trace</span></div>
      <div class="row"><span class="name">coordinator</span><span class="arrow">→</span><span class="desc">Saga orchestrator: hold → auth → confirm → capture → commit</span></div>
      <div class="row"><span class="name">inventory</span><span class="arrow">→</span><span class="desc">Holds &amp; availability <span class="tag">Postgres + outbox</span></span></div>
      <div class="row"><span class="name">payments</span><span class="arrow">→</span><span class="desc">Auths &amp; captures, wraps simulated PSP <span class="tag">Postgres + outbox</span></span></div>
      <div class="row"><span class="name">supplier</span><span class="arrow">→</span><span class="desc">Partner confirmations, simulated partner boundary <span class="tag">Postgres + outbox</span></span></div>
      <div class="row"><span class="name">ledger</span><span class="arrow">→</span><span class="desc">Financial record — commits and reversals <span class="tag">Postgres + outbox</span></span></div>
      <div class="row"><span class="name">notifier</span><span class="arrow">→</span><span class="desc">Async consumer of <span class="cmd">ledger.committed</span> — fan-out span link</span></div>
      <div class="row"><span class="name">reconciler</span><span class="arrow">→</span><span class="desc">Periodic divergence detector — findings linked to traces</span></div>
    </div>

    <div class="section">
      <div class="section-title">Shared Libraries</div>
      <div class="row"><span class="name">@signalman/otel</span><span class="arrow"> </span><span class="desc">OTLP exporters, resource identity, managed lifecycle</span></div>
      <div class="row"><span class="name">@signalman/propagation</span><span class="arrow"> </span><span class="desc">W3C trace-context inject/extract for gRPC + broker headers</span></div>
      <div class="row"><span class="name">@signalman/logging</span><span class="arrow"> </span><span class="desc">Structured JSON logger — trace_id / span_id on every line</span></div>
      <div class="row"><span class="name">@signalman/interceptor</span><span class="arrow"> </span><span class="desc">NestJS SERVER spans + RED metrics per handler</span></div>
      <div class="row"><span class="name">@signalman/outbox</span><span class="arrow"> </span><span class="desc">Transactional outbox + relay (InMemory &amp; Postgres-backed)</span></div>
      <div class="row"><span class="name">@signalman/inbox</span><span class="arrow"> </span><span class="desc">Idempotent consumer dedup (InMemory &amp; Postgres-backed)</span></div>
      <div class="row"><span class="name">@signalman/broker</span><span class="arrow"> </span><span class="desc">MessageBroker boundary — InMemory ref + NATS JetStream</span></div>
    </div>

    <div class="section">
      <div class="section-title">Test Suite</div>
      <div class="row"><span class="pass">✓</span>&nbsp;<span class="desc"><span class="pass">62 suites passed</span> &nbsp;<span class="subtle">·</span>&nbsp; <span class="pass">420 tests passed</span> &nbsp;<span class="subtle">·</span>&nbsp; <span class="skip">3 suites skipped</span> <span class="comment">(require live NATS / Postgres)</span></span></div>
    </div>

    <div class="section">
      <div class="section-title">Quick Start</div>
      <div class="row"><span class="cmd">$ docker compose up</span></div>
      <div class="row" style="margin-top:6px">
        <span class="desc"><span class="url">localhost:3000</span> &nbsp;gateway &nbsp;<span class="subtle">·</span>&nbsp; <span class="url">localhost:3001</span> &nbsp;Grafana (Tempo traces + RED dashboards)</span>
      </div>
      <div class="row" style="margin-top:10px">
        <span class="cmd">$ curl -sX POST localhost:3000/bookings \<br>&nbsp;&nbsp;&nbsp;&nbsp;-H 'Content-Type: application/json' \<br>&nbsp;&nbsp;&nbsp;&nbsp;-d '{"customerId":"c1","skuId":"sku-1","amount":100}'</span>
      </div>
      <div class="row" style="margin-top:4px">
        <span class="desc">{ "bookingId": "bk-7f3a2c91…", "status": "<span class="pass">confirmed</span>", "traceId": "4bf92f35…" }</span>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;

await page.setViewportSize({ width: 880, height: 900 });
await page.setContent(OVERVIEW_HTML, { waitUntil: 'networkidle' });
const overviewEl = await page.$('.window');
await overviewEl.screenshot({ path: join(OUT, 'signalman-overview.png') });
console.log('✓ signalman-overview.png');

// ── 2. Trace anatomy screenshot ───────────────────────────────────────────────
const TRACE_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>signalman trace anatomy</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #1e1e2e;
    color: #cdd6f4;
    font-family: 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-size: 13px;
    line-height: 1.7;
    padding: 0;
    width: 900px;
  }
  .window {
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 24px 64px rgba(0,0,0,0.6);
  }
  .titlebar {
    background: #313244;
    padding: 10px 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .dot-red    { background: #f38ba8; }
  .dot-yellow { background: #f9e2af; }
  .dot-green  { background: #a6e3a1; }
  .title { color: #a6adc8; font-size: 12px; margin-left: auto; margin-right: auto; }
  .body { padding: 24px 28px; }
  .meta { color: #6c7086; font-size: 12px; margin-bottom: 18px; }
  .trace-id { color: #89b4fa; }
  .section-title {
    color: #89b4fa; font-size: 12px; text-transform: uppercase;
    letter-spacing: 0.08em; border-bottom: 1px solid #313244;
    padding-bottom: 4px; margin: 14px 0 10px;
  }
  pre {
    font-family: inherit; font-size: 12.5px; line-height: 1.65;
    white-space: pre;
  }
  .tree-line  { color: #585b70; }
  .svc-name   { color: #cba6f7; }
  .span-http  { color: #89b4fa; }
  .span-grpc  { color: #94e2d5; }
  .span-prod  { color: #a6e3a1; }
  .span-cons  { color: #f9e2af; }
  .span-comp  { color: #f38ba8; }
  .attr       { color: #6c7086; }
  .ms         { color: #7f849c; }
  .badge {
    display: inline-block; border-radius: 3px; padding: 1px 5px;
    font-size: 10px; vertical-align: middle; margin-left: 4px;
  }
  .badge-comp { background: #302030; color: #f38ba8; border: 1px solid #f38ba8; }
  .legend {
    margin-top: 18px; padding-top: 10px; border-top: 1px solid #313244;
    display: flex; gap: 20px; font-size: 11px;
  }
  .legend span { display: flex; align-items: center; gap: 5px; }
</style>
</head>
<body>
<div class="window">
  <div class="titlebar">
    <div class="dot dot-red"></div>
    <div class="dot dot-yellow"></div>
    <div class="dot dot-green"></div>
    <div class="title">signalman — booking trace anatomy</div>
  </div>
  <div class="body">
    <div class="meta">
      traceId: <span class="trace-id">4bf92f3577b34da6a3ce929d0e0e4736</span>
      &nbsp;·&nbsp;
      bookingId: <span class="trace-id">bk-7f3a2c91-e1b4-4d3a-b2f1-8e9a0c6d5f3b</span>
    </div>

    <div class="section-title">Happy path — one booking, one connected trace</div>
    <pre><span class="span-http">[S]</span>  <span class="svc-name">gateway</span>         POST /bookings                            <span class="ms">2 ms</span>
<span class="tree-line">└──</span><span class="span-grpc">[C]</span>  <span class="svc-name">gateway</span>         ──▶ coordinator.Book                       <span class="ms">198 ms</span>
<span class="tree-line">   └──</span><span class="span-grpc">[S]</span>  <span class="svc-name">coordinator</span>     Book                                      <span class="ms">195 ms</span>
<span class="tree-line">      ├──</span><span class="span-grpc">[C]</span>  <span class="svc-name">coordinator</span>  ──▶ inventory.Hold       <span class="span-grpc">[S]</span> <span class="svc-name">inventory</span>   <span class="ms">12 ms</span>
<span class="tree-line">      │                                             └──</span><span class="span-prod">[P]</span>  inventory.held  <span class="ms">0.5 ms</span>
<span class="tree-line">      ├──</span><span class="span-grpc">[C]</span>  <span class="svc-name">coordinator</span>  ──▶ payments.Authorize    <span class="span-grpc">[S]</span> <span class="svc-name">payments</span>    <span class="ms">34 ms</span>
<span class="tree-line">      │  </span><span class="attr">                            ← PSP CLIENT span            </span><span class="span-prod">[P]</span>  payment.authorized
<span class="tree-line">      ├──</span><span class="span-grpc">[C]</span>  <span class="svc-name">coordinator</span>  ──▶ supplier.Confirm      <span class="span-grpc">[S]</span> <span class="svc-name">supplier</span>    <span class="ms">87 ms</span>
<span class="tree-line">      │  </span><span class="attr">                            ← partner CLIENT span         </span><span class="span-prod">[P]</span>  supplier.confirmed
<span class="tree-line">      ├──</span><span class="span-grpc">[C]</span>  <span class="svc-name">coordinator</span>  ──▶ payments.Capture      <span class="span-grpc">[S]</span> <span class="svc-name">payments</span>    <span class="ms">18 ms</span>
<span class="tree-line">      │                                             └──</span><span class="span-prod">[P]</span>  payment.captured  <span class="ms">0.5 ms</span>
<span class="tree-line">      └──</span><span class="span-grpc">[C]</span>  <span class="svc-name">coordinator</span>  ──▶ ledger.Commit         <span class="span-grpc">[S]</span> <span class="svc-name">ledger</span>      <span class="ms">9 ms</span>
<span class="tree-line">                                                   └──</span><span class="span-prod">[P]</span>  ledger.committed    <span class="ms">0.5 ms</span>
<span class="tree-line">                                                      └──</span><span class="span-cons">[CON]</span> <span class="svc-name">notifier</span>  ledger.committed  <span class="ms">22 ms</span>
<span class="tree-line">                                                         └──</span><span class="span-grpc">[C]</span>  notify customer   <span class="ms">5 ms</span>
</pre>

    <div class="section-title">Compensation path — supplier failure unwinds the saga</div>
    <pre><span class="span-http">[S]</span>  <span class="svc-name">gateway</span>         POST /bookings
<span class="tree-line">└──</span><span class="span-grpc">[C]</span>  ──▶ coordinator.Book
<span class="tree-line">   └──</span><span class="span-grpc">[S]</span>  <span class="svc-name">coordinator</span>     Book
<span class="tree-line">      ├──</span><span class="span-grpc">[C]</span>  ──▶ inventory.Hold      ✓
<span class="tree-line">      ├──</span><span class="span-grpc">[C]</span>  ──▶ payments.Authorize  ✓
<span class="tree-line">      ├──</span><span class="span-grpc">[C]</span>  ──▶ supplier.Confirm    <span class="span-comp">✗ FAILURE</span>  <span class="attr">(SUPPLIER_FAILURE_RATE=1.0)</span>
<span class="tree-line">      ├──</span><span class="span-comp">[C]</span>  saga.compensation.payments.void      <span class="badge badge-comp">compensation</span>  <span class="attr">signalman.saga.compensation=true</span>
<span class="tree-line">      │   └──</span><span class="span-grpc">[S]</span>  <span class="svc-name">payments</span>  Void        <span class="span-prod">[P]</span>  payment.voided
<span class="tree-line">      └──</span><span class="span-comp">[C]</span>  saga.compensation.inventory.release  <span class="badge badge-comp">compensation</span>  <span class="attr">signalman.saga.compensation=true</span>
<span class="tree-line">          └──</span><span class="span-grpc">[S]</span>  <span class="svc-name">inventory</span> Release     <span class="span-prod">[P]</span>  inventory.released
</pre>

    <div class="section-title">Reconciler — divergence finding linked to the booking trace</div>
    <pre><span class="span-grpc">[S]</span>  <span class="svc-name">reconciler</span>  reconcile.pass           <span class="attr">(runs every RECONCILER_INTERVAL_MS)</span>
<span class="tree-line">└──</span><span class="span-comp">[S]</span>  <span class="svc-name">reconciler</span>  reconcile.divergence  kind=supplier_confirmed_ledger_missing
<span class="tree-line">    </span><span class="attr">             ↗ span link → traceId: 4bf92f3577b34da6a3ce929d0e0e4736</span>
<span class="tree-line">    </span><span class="attr">               (jump from the finding straight to the originating booking in Tempo)</span>
</pre>

    <div class="legend">
      <span><span style="color:#89b4fa">[S]</span> SERVER span</span>
      <span><span style="color:#94e2d5">[C]</span> CLIENT span</span>
      <span><span style="color:#a6e3a1">[P]</span> PRODUCER span</span>
      <span><span style="color:#f9e2af">[CON]</span> CONSUMER span</span>
      <span><span style="color:#f38ba8">compensation</span> signalman.saga.compensation=true</span>
    </div>
  </div>
</div>
</body>
</html>`;

await page.setViewportSize({ width: 900, height: 1100 });
await page.setContent(TRACE_HTML, { waitUntil: 'networkidle' });
const traceEl = await page.$('.window');
await traceEl.screenshot({ path: join(OUT, 'signalman-trace-anatomy.png') });
console.log('✓ signalman-trace-anatomy.png');

await browser.close();
console.log('\nScreenshots written to docs/screenshots/');
