/**
 * @llm402/openclaw-provider test suite
 *
 * Proper async test runner — no setTimeout race conditions.
 * Mock upstream server for proxy flow tests.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import type { Server, AddressInfo } from 'net';
import { validateConfig } from '../src/config.js';
import { BudgetTracker, BudgetError } from '../src/budget.js';
import { ModelCatalog } from '../src/catalog.js';
import { PaymentProxy } from '../src/proxy.js';
import { PLUGIN_VERSION, USER_AGENT, KNOWN_BROKEN_VERSIONS, assertVersionNotBroken } from '../src/version.js';
import { redactSecrets } from '../src/redact.js';
import { resolveBaseUrl, resolveBaseRpcUrl, BASEURL_PROD, BASE_RPC_URL_PROD } from '../src/config.js';
import { Llm402Wallet } from '../src/lib/index.js';

let passed = 0;
let failed = 0;
let skipped = 0;

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

function skip(name: string, reason: string): void {
  tests.push({
    name,
    fn: () => {
      console.log(`  SKIP  ${name} (${reason})`);
      skipped++;
      throw '__SKIP__';
    },
  });
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function assertThrows(fn: () => void, expectedSubstring?: string): void {
  try {
    fn();
    throw new Error(`Expected to throw${expectedSubstring ? ` (containing "${expectedSubstring}")` : ''}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Expected to throw')) throw err;
    if (expectedSubstring && err instanceof Error && !err.message.includes(expectedSubstring)) {
      throw new Error(`Expected error containing "${expectedSubstring}", got: "${err.message}"`);
    }
  }
}

// ====================== CONFIG TESTS ======================

console.log('\n== Config Validation Tests ==\n');

test('Valid balance config', () => {
  const config = validateConfig({
    paymentMode: 'balance',
    balanceToken: 'bal_' + 'a'.repeat(43),
  });
  assert(config.paymentMode === 'balance', 'mode should be balance');
  assert(config.baseUrl === 'https://llm402.ai', 'default baseUrl');
  assert(config.maxRequestBudgetSats === 500, 'default per-request budget');
  assert(config.sessionBudgetSats === 10_000, 'default session budget');
});

test('Valid cashu config', () => {
  const config = validateConfig({ paymentMode: 'cashu', cashuNsec: 'nsec1' + 'a'.repeat(58) });
  assert(config.paymentMode === 'cashu', 'mode');
});

test('Valid x402 config', () => {
  const config = validateConfig({ paymentMode: 'x402', evmPrivateKey: '0x' + 'a'.repeat(64) });
  assert(config.paymentMode === 'x402', 'mode');
});

test('Valid lightning config', () => {
  const config = validateConfig({ paymentMode: 'lightning', cashuNsec: 'nsec1' + 'a'.repeat(58) });
  assert(config.paymentMode === 'lightning', 'mode');
});

test('Balance mode requires balanceToken', () => {
  assertThrows(() => validateConfig({ paymentMode: 'balance' }), 'Missing required credential');
});

test('Cashu mode requires nsec', () => {
  assertThrows(() => validateConfig({ paymentMode: 'cashu' }), 'Missing required credential');
});

test('x402 mode requires evmPrivateKey', () => {
  assertThrows(() => validateConfig({ paymentMode: 'x402' }), 'Missing required credential');
});

test('Invalid balance token format rejected', () => {
  assertThrows(() => validateConfig({ paymentMode: 'balance', balanceToken: 'not_valid' }));
});

test('Invalid EVM key format rejected', () => {
  assertThrows(() => validateConfig({ paymentMode: 'x402', evmPrivateKey: 'not-a-key' }));
});

test('HTTP baseUrl rejected', () => {
  assertThrows(() => validateConfig({
    paymentMode: 'balance', balanceToken: 'bal_' + 'a'.repeat(43), baseUrl: 'http://llm402.ai',
  }));
});

test('Localhost baseUrl rejected', () => {
  assertThrows(() => validateConfig({
    paymentMode: 'balance', balanceToken: 'bal_' + 'a'.repeat(43), baseUrl: 'https://localhost',
  }));
});

test('Private IP 192.168.x rejected', () => {
  assertThrows(() => validateConfig({
    paymentMode: 'balance', balanceToken: 'bal_' + 'a'.repeat(43), baseUrl: 'https://192.168.1.1',
  }));
});

test('Private IP 10.x rejected', () => {
  assertThrows(() => validateConfig({
    paymentMode: 'balance', balanceToken: 'bal_' + 'a'.repeat(43), baseUrl: 'https://10.0.0.1',
  }));
});

test('Private IP 172.16.x rejected', () => {
  assertThrows(() => validateConfig({
    paymentMode: 'balance', balanceToken: 'bal_' + 'a'.repeat(43), baseUrl: 'https://172.16.0.1',
  }));
});

test('IPv6 loopback [::1] rejected', () => {
  assertThrows(() => validateConfig({
    paymentMode: 'balance', balanceToken: 'bal_' + 'a'.repeat(43), baseUrl: 'https://[::1]',
  }));
});

test('IPv6-mapped loopback rejected', () => {
  assertThrows(() => validateConfig({
    paymentMode: 'balance', balanceToken: 'bal_' + 'a'.repeat(43), baseUrl: 'https://[::ffff:127.0.0.1]',
  }));
});

test('IPv6-mapped private IP rejected', () => {
  assertThrows(() => validateConfig({
    paymentMode: 'balance', balanceToken: 'bal_' + 'a'.repeat(43), baseUrl: 'https://[::ffff:10.0.0.1]',
  }));
});

test('IPv6 ULA (fd) rejected', () => {
  assertThrows(() => validateConfig({
    paymentMode: 'balance', balanceToken: 'bal_' + 'a'.repeat(43), baseUrl: 'https://[fd00::1]',
  }));
});

test('Custom budget values', () => {
  const config = validateConfig({
    paymentMode: 'balance', balanceToken: 'bal_' + 'a'.repeat(43),
    maxRequestBudgetSats: 1000, sessionBudgetSats: 50_000,
  });
  assert(config.maxRequestBudgetSats === 1000, 'custom per-request');
  assert(config.sessionBudgetSats === 50_000, 'custom session');
});

test('Zero budget rejected', () => {
  assertThrows(() => validateConfig({
    paymentMode: 'balance', balanceToken: 'bal_' + 'a'.repeat(43), maxRequestBudgetSats: 0,
  }));
});

test('Negative budget rejected', () => {
  assertThrows(() => validateConfig({
    paymentMode: 'balance', balanceToken: 'bal_' + 'a'.repeat(43), sessionBudgetSats: -1,
  }));
});

// ====================== BUDGET TESTS ======================

console.log('\n== Budget Tracker Tests ==\n');

test('Budget reserve within limits', () => {
  const budget = new BudgetTracker(500, 10_000);
  budget.reserve(100);
  assert(budget.getRemaining() === 9_900, 'remaining');
  assert(budget.getSpent() === 100, 'spent');
});

test('Budget release refunds correctly', () => {
  const budget = new BudgetTracker(500, 10_000);
  budget.reserve(300);
  assert(budget.getSpent() === 300, 'reserved');
  budget.release(300);
  assert(budget.getSpent() === 0, 'released');
  assert(budget.getRemaining() === 10_000, 'full budget after release');
});

test('Budget rejects over per-request limit', () => {
  const budget = new BudgetTracker(500, 10_000);
  assertThrows(() => budget.reserve(501), 'per-request limit');
});

test('Budget rejects over session limit', () => {
  const budget = new BudgetTracker(500, 100);
  budget.reserve(80);
  assertThrows(() => budget.reserve(50), 'budget');
});

test('Budget rejects zero amount', () => {
  assertThrows(() => new BudgetTracker(500, 10_000).reserve(0));
});

test('Budget rejects negative amount', () => {
  assertThrows(() => new BudgetTracker(500, 10_000).reserve(-1));
});

test('Budget rejects NaN amount', () => {
  assertThrows(() => new BudgetTracker(500, 10_000).reserve(NaN));
});

test('Budget rejects Infinity amount', () => {
  assertThrows(() => new BudgetTracker(500, 10_000).reserve(Infinity));
});

test('Budget release rejects NaN', () => {
  assertThrows(() => new BudgetTracker(500, 10_000).release(NaN));
});

test('Budget release rejects negative', () => {
  assertThrows(() => new BudgetTracker(500, 10_000).release(-100));
});

test('Budget release floors at zero', () => {
  const budget = new BudgetTracker(500, 10_000);
  budget.reserve(100);
  budget.release(500); // release more than reserved
  assert(budget.getSpent() === 0, 'floors at zero');
});

test('Budget constructor rejects invalid params', () => {
  assertThrows(() => new BudgetTracker(0, 10_000));
  assertThrows(() => new BudgetTracker(500, -1));
  assertThrows(() => new BudgetTracker(NaN, 10_000));
});

test('Budget accumulates correctly to exhaustion', () => {
  const budget = new BudgetTracker(500, 10_000);
  for (let i = 0; i < 20; i++) { budget.reserve(500); }
  assert(budget.getSpent() === 10_000, 'spent 10K');
  assert(budget.getRemaining() === 0, 'nothing remaining');
  assertThrows(() => budget.reserve(1), 'budget');
});

test('BudgetError is instanceof Error', () => {
  const err = new BudgetError('test');
  assert(err instanceof Error, 'is Error');
  assert(err.name === 'BudgetError', 'name');
});

// ====================== CATALOG TESTS ======================

console.log('\n== Model Catalog Tests ==\n');

test('Catalog fetches models from live API', async () => {
  const catalog = new ModelCatalog('https://llm402.ai');
  const models = await catalog.getModels();
  assert(models.length > 50, `expected 50+ models, got ${models.length}`);
  assert(models[0].id.length > 0, 'model has id');
  assert(models[0].name.length > 0, 'model has name');
});

test('Catalog caches results', async () => {
  const catalog = new ModelCatalog('https://llm402.ai');
  await catalog.getModels(); // warm cache
  const t = Date.now();
  await catalog.getModels(); // cached
  assert(Date.now() - t < 50, 'cached fetch should be <50ms');
});

test('Catalog handles bad URL gracefully', async () => {
  const catalog = new ModelCatalog('https://nonexistent.llm402.test');
  const models = await catalog.getModels();
  assert(models.length === 0, 'should return empty on failure');
});

// ====================== PROXY TESTS ======================

console.log('\n== Proxy Tests ==\n');

test('Proxy starts and stops on localhost', async () => {
  const proxy = new PaymentProxy({
    targetUrl: 'https://llm402.ai', wallet: null,
    budget: new BudgetTracker(500, 10_000), balanceToken: 'bal_' + 'a'.repeat(43),
  });
  await proxy.start();
  assert(proxy.isRunning(), 'running');
  assert(proxy.getBaseUrl().startsWith('http://127.0.0.1:'), 'localhost');
  await proxy.stop();
  assert(!proxy.isRunning(), 'stopped');
});

test('Proxy health check responds', async () => {
  const proxy = new PaymentProxy({
    targetUrl: 'https://llm402.ai', wallet: null,
    budget: new BudgetTracker(500, 10_000), balanceToken: 'bal_' + 'a'.repeat(43),
  });
  await proxy.start();
  try {
    const res = await fetch(`${proxy.getBaseUrl()}/health`);
    assert(res.ok, '200');
    const body = await res.json() as { status: string };
    assert(body.status === 'ok', 'ok');
  } finally { await proxy.stop(); }
});

test('Proxy passes through /v1/models', async () => {
  const proxy = new PaymentProxy({
    targetUrl: 'https://llm402.ai', wallet: null,
    budget: new BudgetTracker(500, 10_000), balanceToken: 'bal_' + 'a'.repeat(43),
  });
  await proxy.start();
  try {
    const res = await fetch(`${proxy.getBaseUrl()}/v1/models`);
    assert(res.ok, '200');
    const body = await res.json() as { object: string; data: unknown[] };
    assert(body.object === 'list', 'list');
    assert(body.data.length > 50, `50+ models, got ${body.data.length}`);
  } finally { await proxy.stop(); }
});

test('Proxy returns 404 for unknown routes', async () => {
  const proxy = new PaymentProxy({
    targetUrl: 'https://llm402.ai', wallet: null,
    budget: new BudgetTracker(500, 10_000), balanceToken: 'bal_' + 'a'.repeat(43),
  });
  await proxy.start();
  try {
    const res = await fetch(`${proxy.getBaseUrl()}/unknown`);
    assert(res.status === 404, '404');
  } finally { await proxy.stop(); }
});

test('Proxy rejects invalid JSON body', async () => {
  const proxy = new PaymentProxy({
    targetUrl: 'https://llm402.ai', wallet: null,
    budget: new BudgetTracker(500, 10_000), balanceToken: 'bal_' + 'a'.repeat(43),
  });
  await proxy.start();
  try {
    const res = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid',
    });
    assert(res.status === 400, '400 for invalid JSON');
  } finally { await proxy.stop(); }
});

// ====================== PROXY FLOW TESTS (mock upstream) ======================

console.log('\n== Proxy Flow Tests (mock upstream) ==\n');

/** Create a mock upstream that returns 402 for probes and 200 for paid requests. */
function createMockUpstream(): Promise<{ server: Server; port: number; requests: Array<{ url: string; headers: Record<string, string> }> }> {
  return new Promise((resolve) => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push({ url: req.url || '', headers: req.headers as Record<string, string> });

      // Consume body
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk; });
      req.on('end', () => {
        if (req.url === '/v1/chat/completions') {
          // Check if this is a paid request
          const hasAuth = req.headers['authorization']?.startsWith('Bearer bal_') ||
                          req.headers['authorization']?.startsWith('L402 ') ||
                          req.headers['x-cashu'] ||
                          req.headers['payment-signature'];

          if (hasAuth) {
            // Paid request — return success
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: 'test-123', object: 'chat.completion', created: Date.now(),
              model: 'test-model',
              choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from mock!' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
            }));
          } else {
            // Probe — return 402
            res.writeHead(402, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'Payment Required',
              price: 10,
              model: 'test-model',
              provider: 'llm402.ai',
              max_tokens: 100,
              estimated_input_tokens: 5,
              cashu: { price_sats: 10, unit: 'sat', description: 'test' },
            }));
          }
        } else if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model', object: 'model', created: 0, owned_by: 'test' }] }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port, requests });
    });
  });
}

test('Balance mode: proxy forwards with Bearer header', async () => {
  const mock = await createMockUpstream();
  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${mock.port}`,
    wallet: null,
    budget: new BudgetTracker(500, 10_000),
    balanceToken: 'bal_' + 'a'.repeat(43),
  });
  await proxy.start();
  try {
    const res = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(res.ok, `expected 200, got ${res.status}`);
    const body = await res.json() as { choices: Array<{ message: { content: string } }> };
    assert(body.choices[0].message.content === 'Hello from mock!', 'response content');

    // Verify the proxy sent Bearer auth
    const paidReq = mock.requests.find(r => r.headers['authorization']?.startsWith('Bearer bal_'));
    assert(!!paidReq, 'proxy should send Bearer auth');
  } finally {
    await proxy.stop();
    mock.server.close();
  }
});

test('Wallet mode: proxy does probe-pay-retry (no wallet = all fail)', async () => {
  const mock = await createMockUpstream();
  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${mock.port}`,
    wallet: new Llm402Wallet(), // uninitialized — all payment methods will fail
    budget: new BudgetTracker(500, 10_000),
  });
  await proxy.start();
  try {
    const res = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(res.status === 402, `expected 402 (all payments fail), got ${res.status}`);
    const body = await res.json() as { error: string };
    assert(body.error.includes('All payment methods failed'), 'error message');

    // Verify the probe was sent (no auth headers)
    const probeReq = mock.requests.find(r =>
      r.url === '/v1/chat/completions' && !r.headers['authorization'] && !r.headers['x-cashu']
    );
    assert(!!probeReq, 'proxy should send probe without auth');
  } finally {
    await proxy.stop();
    mock.server.close();
  }
});

test('Budget exceeded: proxy rejects before payment', async () => {
  const mock = await createMockUpstream();
  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${mock.port}`,
    wallet: new Llm402Wallet(),
    budget: new BudgetTracker(5, 10_000), // per-request limit 5 sats, price is 10
  });
  await proxy.start();
  try {
    const res = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(res.status === 402, `expected 402 (budget exceeded), got ${res.status}`);
    const body = await res.json() as { error: string };
    assert(body.error.includes('per-request limit'), 'budget error');
  } finally {
    await proxy.stop();
    mock.server.close();
  }
});

test('No wallet or balance token: proxy returns 500', async () => {
  const mock = await createMockUpstream();
  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${mock.port}`,
    wallet: null,
    budget: new BudgetTracker(500, 10_000),
    // No balanceToken, no wallet
  });
  await proxy.start();
  try {
    const res = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(res.status === 500, `expected 500, got ${res.status}`);
  } finally {
    await proxy.stop();
    mock.server.close();
  }
});

// ====================== UPSTREAM FAILURE & EDGE CASE TESTS ======================

console.log('\n== Upstream Failure & Edge Case Tests ==\n');

/**
 * Create a mock upstream that accepts auth but returns 500 on paid requests.
 * Simulates upstream infrastructure failure after payment is accepted.
 */
function createMockUpstream500OnPaid(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk; });
      req.on('end', () => {
        if (req.url === '/v1/chat/completions') {
          const hasAuth = req.headers['authorization']?.startsWith('Bearer bal_');
          if (hasAuth) {
            // Paid request — upstream blows up
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal Server Error' }));
          } else {
            // Probe — return 402
            res.writeHead(402, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'Payment Required', price: 10, model: 'test-model',
              provider: 'llm402.ai', max_tokens: 100, estimated_input_tokens: 5,
              cashu: { price_sats: 10, unit: 'sat', description: 'test' },
            }));
          }
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

test('Upstream 500 on paid request (balance mode): proxy forwards error status', async () => {
  const mock = await createMockUpstream500OnPaid();
  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${mock.port}`,
    wallet: null,
    budget: new BudgetTracker(500, 10_000),
    balanceToken: 'bal_' + 'a'.repeat(43),
  });
  await proxy.start();
  try {
    const res = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(res.status === 500, `expected 500 forwarded, got ${res.status}`);
    const body = await res.json() as { error: string };
    assert(body.error === 'Internal Server Error', `expected upstream error, got: ${body.error}`);
  } finally {
    await proxy.stop();
    mock.server.close();
  }
});

/**
 * Create a mock upstream that returns 200 for ALL requests (no payment required).
 * This should cause the proxy to reject with "did not require payment" in wallet mode.
 */
function createMockUpstreamAlways200(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'free-123', object: 'chat.completion', created: Date.now(),
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Free!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

test('Probe returns 200 (no payment needed): proxy returns 500 with "did not require payment"', async () => {
  const mock = await createMockUpstreamAlways200();
  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${mock.port}`,
    wallet: new Llm402Wallet(),
    budget: new BudgetTracker(500, 10_000),
    // No balanceToken — forces wallet mode probe-pay-retry
  });
  await proxy.start();
  try {
    const res = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(res.status === 500, `expected 500, got ${res.status}`);
    const body = await res.json() as { error: string };
    assert(body.error.includes('did not require payment'), `expected 'did not require payment', got: ${body.error}`);
  } finally {
    await proxy.stop();
    mock.server.close();
  }
});

/**
 * Create a mock upstream that returns 402 with price: 0.
 * Zero price is invalid — proxy should reject with "invalid price".
 */
function createMockUpstreamZeroPrice(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk; });
      req.on('end', () => {
        if (req.url === '/v1/chat/completions') {
          res.writeHead(402, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Payment Required', price: 0, model: 'test-model',
            provider: 'llm402.ai', max_tokens: 100, estimated_input_tokens: 5,
            cashu: { price_sats: 0, unit: 'sat', description: 'test' },
          }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

test('Probe returns 402 with zero price: proxy returns 502 with "invalid price"', async () => {
  const mock = await createMockUpstreamZeroPrice();
  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${mock.port}`,
    wallet: new Llm402Wallet(),
    budget: new BudgetTracker(500, 10_000),
  });
  await proxy.start();
  try {
    const res = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(res.status === 502, `expected 502, got ${res.status}`);
    const body = await res.json() as { error: string };
    assert(body.error.includes('invalid price'), `expected 'invalid price', got: ${body.error}`);
  } finally {
    await proxy.stop();
    mock.server.close();
  }
});

/**
 * Create a mock upstream that returns 402 with no price fields at all.
 * Missing price and cashu.price_sats — proxy should reject with "invalid price".
 */
function createMockUpstreamMissingPrice(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk; });
      req.on('end', () => {
        if (req.url === '/v1/chat/completions') {
          res.writeHead(402, { 'Content-Type': 'application/json' });
          // Deliberately omit both `price` and `cashu` fields
          res.end(JSON.stringify({
            error: 'Payment Required', model: 'test-model',
            provider: 'llm402.ai', max_tokens: 100, estimated_input_tokens: 5,
          }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

test('Probe returns 402 with missing price fields: proxy returns 502', async () => {
  const mock = await createMockUpstreamMissingPrice();
  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${mock.port}`,
    wallet: new Llm402Wallet(),
    budget: new BudgetTracker(500, 10_000),
  });
  await proxy.start();
  try {
    const res = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(res.status === 502, `expected 502, got ${res.status}`);
    const body = await res.json() as { error: string };
    assert(body.error.includes('invalid price'), `expected 'invalid price', got: ${body.error}`);
  } finally {
    await proxy.stop();
    mock.server.close();
  }
});

test('Request body exactly at 1MB limit: accepted', async () => {
  const mock = await createMockUpstream();
  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${mock.port}`,
    wallet: null,
    budget: new BudgetTracker(500, 10_000),
    balanceToken: 'bal_' + 'a'.repeat(43),
  });
  await proxy.start();
  try {
    // Build a JSON body that is exactly 1,048,576 bytes (1MB)
    // {"model":"test","messages":[{"role":"user","content":"AAA..."}]}
    const prefix = '{"model":"test","messages":[{"role":"user","content":"';
    const suffix = '"}]}';
    const overhead = Buffer.byteLength(prefix + suffix, 'utf8');
    const padding = 'A'.repeat(1_048_576 - overhead);
    const exactBody = prefix + padding + suffix;
    assert(Buffer.byteLength(exactBody, 'utf8') === 1_048_576, `body should be exactly 1MB, got ${Buffer.byteLength(exactBody, 'utf8')}`);

    const res = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: exactBody,
    });
    // Should be accepted — proxy reads the body and forwards to upstream.
    // The mock upstream will return 200 for authenticated requests.
    assert(res.status === 200, `expected 200 for exactly 1MB body, got ${res.status}`);
  } finally {
    await proxy.stop();
    mock.server.close();
  }
});

test('Request body over 1MB limit: rejected', async () => {
  const mock = await createMockUpstream();
  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${mock.port}`,
    wallet: null,
    budget: new BudgetTracker(500, 10_000),
    balanceToken: 'bal_' + 'a'.repeat(43),
  });
  await proxy.start();
  try {
    // Build a JSON body that is 1,048,577 bytes (1MB + 1)
    const prefix = '{"model":"test","messages":[{"role":"user","content":"';
    const suffix = '"}]}';
    const overhead = Buffer.byteLength(prefix + suffix, 'utf8');
    const padding = 'A'.repeat(1_048_577 - overhead);
    const overBody = prefix + padding + suffix;
    assert(Buffer.byteLength(overBody, 'utf8') === 1_048_577, `body should be 1MB+1, got ${Buffer.byteLength(overBody, 'utf8')}`);

    // readBody() calls req.destroy() which kills the socket. The proxy tries
    // to write a 400 response, but the socket may already be dead. So we may
    // get either a clean 400 response OR a fetch error (connection reset).
    // Both outcomes mean the oversized body was rejected — the request did NOT
    // proceed to upstream or payment.
    try {
      const res = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: overBody,
      });
      // If we got a response, it must be 400
      assert(res.status === 400, `expected 400 for over-limit body, got ${res.status}`);
    } catch (err) {
      // Connection reset / fetch failed is also acceptable — the oversized
      // body was rejected before reaching any handler
      assert(err instanceof Error, 'should be an Error');
      assert(
        err.message.includes('fetch failed') || err.message.includes('ECONNRESET') ||
        err.message.includes('socket hang up') || err.message.includes('terminated'),
        `unexpected fetch error: ${err.message}`
      );
    }

    // Verify the oversized request never reached the mock upstream
    const upstreamHits = mock.requests.filter(r => r.url === '/v1/chat/completions');
    assert(upstreamHits.length === 0, `oversized request should not reach upstream, got ${upstreamHits.length} hits`);
  } finally {
    await proxy.stop();
    mock.server.close();
  }
});

test('Proxy auth token enforcement: missing token returns 403', async () => {
  const mock = await createMockUpstream();
  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${mock.port}`,
    wallet: null,
    budget: new BudgetTracker(500, 10_000),
    balanceToken: 'bal_' + 'a'.repeat(43),
    proxyAuthToken: 'secret-session-token-12345',
  });
  await proxy.start();
  try {
    // Request WITHOUT the proxy auth token — should be rejected
    const res = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(res.status === 403, `expected 403 without proxy auth token, got ${res.status}`);
    const body = await res.json() as { error: string };
    assert(body.error === 'Unauthorized', `expected 'Unauthorized', got: ${body.error}`);

    // Health check also blocked without token
    const healthRes = await fetch(`${proxy.getBaseUrl()}/health`);
    assert(healthRes.status === 403, `expected 403 on /health without token, got ${healthRes.status}`);
  } finally {
    await proxy.stop();
    mock.server.close();
  }
});

test('Proxy auth token enforcement: correct token succeeds', async () => {
  const mock = await createMockUpstream();
  const token = 'secret-session-token-12345';
  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${mock.port}`,
    wallet: null,
    budget: new BudgetTracker(500, 10_000),
    balanceToken: 'bal_' + 'a'.repeat(43),
    proxyAuthToken: token,
  });
  await proxy.start();
  try {
    // Request WITH the correct proxy auth token — should succeed
    const res = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Auth': token,
      },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(res.status === 200, `expected 200 with proxy auth token, got ${res.status}`);
    const body = await res.json() as { choices: Array<{ message: { content: string } }> };
    assert(body.choices[0].message.content === 'Hello from mock!', 'response content');

    // Health check also passes with token
    const healthRes = await fetch(`${proxy.getBaseUrl()}/health`, {
      headers: { 'X-Proxy-Auth': token },
    });
    assert(healthRes.status === 200, `expected 200 on /health with token, got ${healthRes.status}`);
  } finally {
    await proxy.stop();
    mock.server.close();
  }
});

test('Proxy auth token enforcement: wrong token returns 403', async () => {
  const mock = await createMockUpstream();
  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${mock.port}`,
    wallet: null,
    budget: new BudgetTracker(500, 10_000),
    balanceToken: 'bal_' + 'a'.repeat(43),
    proxyAuthToken: 'correct-token',
  });
  await proxy.start();
  try {
    const res = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Auth': 'wrong-token',
      },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(res.status === 403, `expected 403 with wrong token, got ${res.status}`);
  } finally {
    await proxy.stop();
    mock.server.close();
  }
});

// ====================== X402 SIGNING PATH TESTS ======================

console.log('\n== x402 Signing Path Tests ==\n');

/** Mock upstream returning 402 with custom x402 fields. */
function createX402MockUpstream(x402Fields: Record<string, unknown>): Promise<{
  server: Server; port: number;
  requests: Array<{ url: string; headers: Record<string, string> }>;
}> {
  return new Promise((resolve) => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push({ url: req.url || '', headers: req.headers as Record<string, string> });
      let body = '';
      req.on('data', (c: Buffer) => { body += c; });
      req.on('end', () => {
        if (req.url === '/v1/chat/completions') {
          if (req.headers['payment-signature'] || req.headers['authorization']?.startsWith('L402 ') || req.headers['x-cashu']) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: 'x402-ok', object: 'chat.completion', created: Date.now(), model: 'test',
              choices: [{ index: 0, message: { role: 'assistant', content: 'Paid via x402!' }, finish_reason: 'stop' }],
            }));
          } else {
            // Build v2 Payment-Required header envelope from x402 fields
            const headers402: Record<string, string> = { 'Content-Type': 'application/json' };
            if (x402Fields.price_usd && x402Fields.address && x402Fields.asset && x402Fields.network) {
              const priceUsd = parseFloat(String(x402Fields.price_usd).replace('$', ''));
              if (Number.isFinite(priceUsd) && priceUsd > 0) {
                const envelope = {
                  x402Version: 2,
                  error: 'Payment required',
                  accepts: [{
                    scheme: x402Fields.scheme || 'exact',
                    network: x402Fields.network,
                    amount: Math.ceil(priceUsd * 1_000_000).toString(),
                    asset: x402Fields.asset,
                    payTo: x402Fields.address,
                    maxTimeoutSeconds: 120,
                    extra: { name: 'USD Coin', version: '2' },
                  }],
                  resource: { url: '/v1/chat/completions', description: 'LLM inference', mimeType: 'application/json' },
                  price: `$${priceUsd.toFixed(6)}`,
                };
                headers402['Payment-Required'] = Buffer.from(JSON.stringify(envelope)).toString('base64');
              }
            }
            res.writeHead(402, headers402);
            res.end(JSON.stringify({
              error: 'Payment Required', price: 10, model: 'test', provider: 'llm402.ai',
              max_tokens: 100, estimated_input_tokens: 5,
              cashu: { price_sats: 10, unit: 'sat', description: 'test' },
              x402: x402Fields,
            }));
          }
        } else { res.writeHead(404); res.end(); }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port, requests });
    });
  });
}

/** Mock wallet: Cashu always fails, forcing x402 path. */
function mockWalletWithEvmKey(key: string): Llm402Wallet {
  return {
    selectProofs: async () => { throw new Error('Mock: Cashu unavailable'); },
    getEvmPrivateKey: () => key,
    meltForInvoice: async () => { throw new Error('Mock: L402 unavailable'); },
    addChangeProofs: async () => {},
  } as unknown as Llm402Wallet;
}

const TEST_EVM_KEY = '0x' + 'ab'.repeat(32);
const VALID_PAYTO = '0xe05cf38aabc0a046cf0057d2656f3c374132667a';
const VALID_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const VALID_NETWORK = 'eip155:8453';
function validX402(overrides?: Record<string, unknown>): Record<string, unknown> {
  return { price_usd: '$0.01', network: VALID_NETWORK, address: VALID_PAYTO, asset: VALID_ASSET, scheme: 'exact', ...overrides };
}
async function chatViaProxy(baseUrl: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
  });
}

test('x402: rejects wrong payTo address', async () => {
  const mock = await createX402MockUpstream(validX402({ address: '0x0000000000000000000000000000000000000001' }));
  const proxy = new PaymentProxy({ targetUrl: `http://127.0.0.1:${mock.port}`, wallet: mockWalletWithEvmKey(TEST_EVM_KEY), budget: new BudgetTracker(500, 10_000) });
  await proxy.start();
  try {
    const res = await chatViaProxy(proxy.getBaseUrl());
    assert(res.status === 402, `expected 402, got ${res.status}`);
    const body = await res.json() as { error: string };
    assert(body.error.includes('x402: payment_failed'), `expected x402 payment_failed, got: ${body.error}`);
  } finally { await proxy.stop(); mock.server.close(); }
});

test('x402: rejects wrong asset address', async () => {
  const mock = await createX402MockUpstream(validX402({ asset: '0x0000000000000000000000000000000000000bad' }));
  const proxy = new PaymentProxy({ targetUrl: `http://127.0.0.1:${mock.port}`, wallet: mockWalletWithEvmKey(TEST_EVM_KEY), budget: new BudgetTracker(500, 10_000) });
  await proxy.start();
  try {
    const res = await chatViaProxy(proxy.getBaseUrl());
    assert(res.status === 402, `expected 402, got ${res.status}`);
    const body = await res.json() as { error: string };
    assert(body.error.includes('x402: payment_failed'), `expected x402 payment_failed, got: ${body.error}`);
  } finally { await proxy.stop(); mock.server.close(); }
});

test('x402: rejects wrong network', async () => {
  const mock = await createX402MockUpstream(validX402({ network: 'eip155:1' }));
  const proxy = new PaymentProxy({ targetUrl: `http://127.0.0.1:${mock.port}`, wallet: mockWalletWithEvmKey(TEST_EVM_KEY), budget: new BudgetTracker(500, 10_000) });
  await proxy.start();
  try {
    const res = await chatViaProxy(proxy.getBaseUrl());
    assert(res.status === 402, `expected 402, got ${res.status}`);
    const body = await res.json() as { error: string };
    assert(body.error.includes('x402: payment_failed'), `expected x402 payment_failed, got: ${body.error}`);
  } finally { await proxy.stop(); mock.server.close(); }
});

test('x402: rejects price over $5 USDC cap', async () => {
  // $6 = 6_000_000 atomic > MAX_USDC_PER_REQUEST_ATOMIC (5_000_000)
  const mock = await createX402MockUpstream(validX402({ price_usd: '$6.00' }));
  const proxy = new PaymentProxy({ targetUrl: `http://127.0.0.1:${mock.port}`, wallet: mockWalletWithEvmKey(TEST_EVM_KEY), budget: new BudgetTracker(500, 10_000) });
  await proxy.start();
  try {
    const res = await chatViaProxy(proxy.getBaseUrl());
    assert(res.status === 402, `expected 402, got ${res.status}`);
    const body = await res.json() as { error: string };
    assert(body.error.includes('x402: payment_failed'), `expected x402 payment_failed, got: ${body.error}`);
  } finally { await proxy.stop(); mock.server.close(); }
});

test('x402: missing price_usd makes x402 unavailable (all methods fail)', async () => {
  const mock = await createX402MockUpstream(validX402({ price_usd: null }));
  const proxy = new PaymentProxy({ targetUrl: `http://127.0.0.1:${mock.port}`, wallet: mockWalletWithEvmKey(TEST_EVM_KEY), budget: new BudgetTracker(500, 10_000) });
  await proxy.start();
  try {
    const res = await chatViaProxy(proxy.getBaseUrl());
    assert(res.status === 402, `expected 402, got ${res.status}`);
    const body = await res.json() as { error: string };
    // With invalid price, resolveX402Requirement returns null → x402 skipped entirely
    assert(body.error.includes('All payment methods failed'), `expected all methods failed, got: ${body.error}`);
  } finally { await proxy.stop(); mock.server.close(); }
});

test('x402: negative price makes x402 unavailable (all methods fail)', async () => {
  const mock = await createX402MockUpstream(validX402({ price_usd: '-$5.00' }));
  const proxy = new PaymentProxy({ targetUrl: `http://127.0.0.1:${mock.port}`, wallet: mockWalletWithEvmKey(TEST_EVM_KEY), budget: new BudgetTracker(500, 10_000) });
  await proxy.start();
  try {
    const res = await chatViaProxy(proxy.getBaseUrl());
    assert(res.status === 402, `expected 402, got ${res.status}`);
    const body = await res.json() as { error: string };
    // With negative price, resolveX402Requirement returns null → x402 skipped entirely
    assert(body.error.includes('All payment methods failed'), `expected all methods failed, got: ${body.error}`);
  } finally { await proxy.stop(); mock.server.close(); }
});

test('x402: rejects no EVM key', async () => {
  const mock = await createX402MockUpstream(validX402());
  const noKeyWallet = { ...mockWalletWithEvmKey(''), getEvmPrivateKey: () => '' } as unknown as Llm402Wallet;
  const proxy = new PaymentProxy({ targetUrl: `http://127.0.0.1:${mock.port}`, wallet: noKeyWallet, budget: new BudgetTracker(500, 10_000) });
  await proxy.start();
  try {
    const res = await chatViaProxy(proxy.getBaseUrl());
    assert(res.status === 402, `expected 402, got ${res.status}`);
    const body = await res.json() as { error: string };
    assert(body.error.includes('x402: payment_failed'), `expected x402 payment_failed, got: ${body.error}`);
  } finally { await proxy.stop(); mock.server.close(); }
});

test('x402: full signing produces valid base64 payload', async () => {
  const mock = await createX402MockUpstream(validX402());
  const proxy = new PaymentProxy({ targetUrl: `http://127.0.0.1:${mock.port}`, wallet: mockWalletWithEvmKey(TEST_EVM_KEY), budget: new BudgetTracker(500, 10_000) });
  await proxy.start();
  try {
    const res = await chatViaProxy(proxy.getBaseUrl());
    assert(res.status === 200, `expected 200, got ${res.status}`);

    const paidReq = mock.requests.find(r => r.headers['payment-signature']);
    assert(!!paidReq, 'should have sent Payment-Signature');

    const decoded = JSON.parse(Buffer.from(paidReq!.headers['payment-signature'], 'base64').toString());
    assert(decoded.x402Version === 2, 'x402Version');
    assert(decoded.resource.url.includes('/v1/chat/completions'), 'resource.url');
    assert(decoded.accepted.network === VALID_NETWORK, 'accepted.network');
    assert(decoded.accepted.asset === VALID_ASSET, 'accepted.asset');
    assert(decoded.accepted.amount === '10000', `amount should be 10000 (=$0.01), got ${decoded.accepted.amount}`);
    assert(decoded.payload.signature.startsWith('0x'), 'signature starts with 0x');
    assert(decoded.payload.signature.length === 132, `sig length should be 132, got ${decoded.payload.signature.length}`);
    assert(decoded.payload.authorization.nonce.startsWith('0x'), 'nonce hex');
    assert(decoded.payload.authorization.nonce.length === 66, 'nonce 66 chars');
  } finally { await proxy.stop(); mock.server.close(); }
});

test('x402: budget released when all methods fail', async () => {
  const mock = await createX402MockUpstream(validX402({ address: '0x0000000000000000000000000000000000BAD' }));
  const budget = new BudgetTracker(500, 10_000);
  const proxy = new PaymentProxy({ targetUrl: `http://127.0.0.1:${mock.port}`, wallet: mockWalletWithEvmKey(TEST_EVM_KEY), budget });
  await proxy.start();
  try {
    const before = budget.getRemaining();
    await chatViaProxy(proxy.getBaseUrl());
    assert(budget.getRemaining() === before, `budget should be released: ${budget.getRemaining()} vs ${before}`);
  } finally { await proxy.stop(); mock.server.close(); }
});

// ====================== BALANCE-MODE BUDGET ENFORCEMENT (HIGH-001) ======================

test('Balance mode: per-request budget enforced via probe', async () => {
  // Mock returns price: 10 sats. Budget allows max 5 per request.
  // Expected: proxy probes, discovers 10 sats > 5 budget, returns 402 before upstream call.
  const mock = await createMockUpstream();
  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${mock.port}`,
    wallet: null,
    budget: new BudgetTracker(5, 10_000),  // maxPerRequestSats: 5 (price is 10)
    balanceToken: 'bal_' + 'a'.repeat(43),
  });
  await proxy.start();
  try {
    const res = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(res.status === 402, `expected 402 budget rejection, got ${res.status}`);
    const body = await res.json() as { error: string };
    assert(body.error.includes('exceeds'), `expected budget error message, got: ${body.error}`);
    // Verify no paid request was sent (only the probe should exist)
    const paidRequests = mock.requests.filter(r => r.headers['authorization']?.startsWith('Bearer bal_'));
    assert(paidRequests.length === 0, `expected 0 paid requests but found ${paidRequests.length}`);
  } finally {
    await proxy.stop();
    mock.server.close();
  }
});

test('Balance mode: session budget exhausted across multiple requests', async () => {
  // Mock returns price: 10 sats. Session budget: 15 sats.
  // First request (10 sats) should succeed. Second request (10 more = 20 > 15) should fail.
  const mock = await createMockUpstream();
  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${mock.port}`,
    wallet: null,
    budget: new BudgetTracker(500, 15),  // sessionBudgetSats: 15, perRequest: 500
    balanceToken: 'bal_' + 'a'.repeat(43),
  });
  await proxy.start();
  try {
    // First request — should succeed (10 sats < 15 session budget)
    const res1 = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(res1.status === 200, `first request expected 200, got ${res1.status}`);

    // Second request — should fail (10 + 10 = 20 > 15 session budget)
    const res2 = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(res2.status === 402, `second request expected 402, got ${res2.status}`);
    const body = await res2.json() as { error: string };
    assert(body.error.includes('budget') || body.error.includes('session'), `expected session budget error, got: ${body.error}`);
  } finally {
    await proxy.stop();
    mock.server.close();
  }
});

// ====================== INTEGRATION TESTS ======================

console.log('\n== Integration Tests ==\n');

if (process.env.OPENCLAW_E2E === '1') {
  const balToken = process.env.LLM402_BALANCE_TOKEN;
  if (balToken) {
    test('E2E: Balance token inference via proxy', async () => {
      const proxy = new PaymentProxy({
        targetUrl: 'https://llm402.ai', wallet: null,
        budget: new BudgetTracker(500, 10_000), balanceToken: balToken,
      });
      await proxy.start();
      try {
        const res = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'Say hello' }], max_tokens: 10 }),
        });
        assert(res.ok, `expected 200, got ${res.status}`);
        const body = await res.json() as { choices: Array<{ message: { content: string } }> };
        assert(body.choices[0].message.content.length > 0, 'has content');
      } finally { await proxy.stop(); }
    });
  } else {
    skip('E2E: Balance token inference', 'set LLM402_BALANCE_TOKEN');
  }
} else {
  skip('E2E integration tests', 'set OPENCLAW_E2E=1');
}

// ====================== LAYER 1 HARDENING TESTS ======================

console.log('\n== Layer 1 Hardening Tests ==\n');

test('Layer 1: PLUGIN_VERSION is 0.3.1', () => {
  assert(PLUGIN_VERSION === '0.3.1', `expected 0.3.1, got "${PLUGIN_VERSION}"`);
});

test('Layer 1: USER_AGENT is llm402-openclaw-provider/<version>', () => {
  assert(
    USER_AGENT === `llm402-openclaw-provider/${PLUGIN_VERSION}`,
    `USER_AGENT should be 'llm402-openclaw-provider/${PLUGIN_VERSION}', got '${USER_AGENT}'`
  );
});

test('Layer 1: package.json, openclaw.plugin.json, src/version.ts all agree on version', async () => {
  const fs = await import('fs');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const man = JSON.parse(fs.readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  const src = fs.readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8');
  const srcMatch = src.match(/PLUGIN_VERSION = '([^']+)'/);
  assert(srcMatch !== null, 'src/version.ts must declare PLUGIN_VERSION');
  const srcVer = srcMatch![1];
  assert(pkg.version === man.version, `package.json (${pkg.version}) != manifest (${man.version})`);
  assert(pkg.version === srcVer, `package.json (${pkg.version}) != src/version.ts (${srcVer})`);
});

test('Layer 1: n>1 in body is stripped to n=1 (probe + paid request)', async () => {
  const probeN: unknown[] = [];
  const paidN: unknown[] = [];
  let callCount = 0;

  const mockServer = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404); res.end(); return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      callCount++;
      if (callCount === 1) {
        probeN.push(parsed.n);
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ price: 1, cashu: { price_sats: 1 } }));
      } else {
        paidN.push(parsed.n);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      }
    });
  });
  const mockPort = await new Promise<number>((resolve) => {
    mockServer.listen(0, '127.0.0.1', () => {
      resolve((mockServer.address() as AddressInfo).port);
    });
  });

  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${mockPort}`,
    wallet: null,
    budget: new BudgetTracker(500, 10_000),
    balanceToken: 'bal_' + 'x'.repeat(43),
  });
  await proxy.start();

  try {
    await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: 'hi' }],
        n: 20,
      }),
    });
    assert(probeN.length === 1, `probe should run once, saw ${probeN.length}`);
    assert(probeN[0] === 1, `probe n should be 1, got ${probeN[0]}`);
    assert(paidN.length === 1, `paid should run once, saw ${paidN.length}`);
    assert(paidN[0] === 1, `paid n should be 1, got ${paidN[0]}`);
  } finally {
    await proxy.stop();
    mockServer.close();
  }
});

test('Layer 1: User-Agent header set on outbound /v1/models passthrough', async () => {
  let seenUA: string | undefined;
  const mockServer = createServer((req, res) => {
    seenUA = req.headers['user-agent'] as string;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>((resolve) => {
    mockServer.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (mockServer.address() as AddressInfo).port;

  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${port}`,
    wallet: null,
    budget: new BudgetTracker(500, 10_000),
    balanceToken: 'bal_' + 'x'.repeat(43),
  });
  await proxy.start();

  try {
    await fetch(`${proxy.getBaseUrl()}/v1/models`);
    assert(seenUA === USER_AGENT, `UA should be "${USER_AGENT}", got "${seenUA}"`);
  } finally {
    await proxy.stop();
    mockServer.close();
  }
});

test('Layer 1: User-Agent header set on probe POST and paid POST', async () => {
  const seenUAs: string[] = [];
  let call = 0;
  const mockServer = createServer((req, res) => {
    seenUAs.push(req.headers['user-agent'] as string);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      call++;
      if (call === 1) {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ price: 1, cashu: { price_sats: 1 } }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      }
    });
  });
  await new Promise<void>((resolve) => {
    mockServer.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (mockServer.address() as AddressInfo).port;

  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${port}`,
    wallet: null,
    budget: new BudgetTracker(500, 10_000),
    balanceToken: 'bal_' + 'x'.repeat(43),
  });
  await proxy.start();

  try {
    await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(seenUAs.length >= 2, `expected >= 2 upstream calls, saw ${seenUAs.length}`);
    assert(seenUAs[0] === USER_AGENT, `probe UA "${seenUAs[0]}" != USER_AGENT`);
    assert(seenUAs[1] === USER_AGENT, `paid UA "${seenUAs[1]}" != USER_AGENT`);
  } finally {
    await proxy.stop();
    mockServer.close();
  }
});

test('Layer 1: Authorization Bearer is rejected (auth contract is x-proxy-auth only)', async () => {
  // Regression guard: earlier index.ts docstring suggested Bearer would work.
  // The code (proxy.ts:handleRequest) only validates `x-proxy-auth`. A Bearer
  // header must produce 403 — the two schemes are NOT interchangeable.
  const proxyToken = 'test-token-' + 'a'.repeat(40);
  const proxy = new PaymentProxy({
    targetUrl: 'http://127.0.0.1:1',  // unreachable; /health never forwards
    wallet: null,
    budget: new BudgetTracker(500, 10_000),
    balanceToken: 'bal_' + 'x'.repeat(43),
    proxyAuthToken: proxyToken,
  });
  await proxy.start();

  try {
    const resBearer = await fetch(`${proxy.getBaseUrl()}/health`, {
      headers: { 'Authorization': `Bearer ${proxyToken}` },
    });
    assert(resBearer.status === 403, `Bearer must be rejected with 403, got ${resBearer.status}`);

    const resXAuth = await fetch(`${proxy.getBaseUrl()}/health`, {
      headers: { 'x-proxy-auth': proxyToken },
    });
    assert(resXAuth.status === 200, `x-proxy-auth must succeed with 200, got ${resXAuth.status}`);
  } finally {
    await proxy.stop();
  }
});

// ====================== LAYER 2 HARDENING TESTS ======================

console.log('\n== Layer 2: redactSecrets ==\n');

test('redact: L402 macaroon:preimage scheme', () => {
  const input = 'Authorization: L402 AgEDbG5kAikxxxxxxxxxxxxxxxxxxxxxx:' + 'a'.repeat(64);
  const out = redactSecrets(input);
  assert(!out.includes('a'.repeat(64)), 'preimage must be redacted');
  assert(out.includes('[redacted]:[redacted]'), 'L402 scheme replacement shape');
});

test('redact: Authorization Bearer header', () => {
  const out = redactSecrets('Authorization: Bearer bal_' + 'x'.repeat(43));
  assert(!out.includes('bal_' + 'x'.repeat(43)), 'bearer token must be redacted');
  assert(out.includes('[redacted]'), 'replacement marker present');
});

test('redact: balance token in isolation', () => {
  const tok = 'bal_' + 'k'.repeat(43);
  const out = redactSecrets(`token = ${tok}`);
  assert(!out.includes(tok), 'balance token must be redacted');
  assert(out.includes('bal_[redacted]'), 'redaction marker present');
});

test('redact: cashu token', () => {
  const tok = 'cashuA' + 'abcDEF123_=/-'.repeat(10);
  const out = redactSecrets(`X-Cashu: ${tok}`);
  assert(!out.includes(tok), 'cashu token must be redacted');
  assert(out.includes('[redacted]'), 'redaction marker present');
});

test('redact: nsec (Nostr secret key)', () => {
  const ns = 'nsec1' + 'a'.repeat(58);
  const out = redactSecrets(`wallet seed: ${ns}`);
  assert(!out.includes(ns), 'nsec must be redacted');
  assert(out.includes('nsec1[redacted]'), 'marker present');
});

test('redact: EVM private key (0x + 64 hex)', () => {
  const key = '0x' + 'f'.repeat(64);
  const out = redactSecrets(`EVM: ${key}`);
  assert(!out.includes(key), 'EVM key must be redacted');
  assert(out.includes('0x[redacted]'), 'marker present');
});

test('redact: multiple secrets in one string', () => {
  const nsec = 'nsec1' + 'b'.repeat(58);
  const bal = 'bal_' + 'x'.repeat(43);
  const input = `failed with nsec=${nsec} and token=${bal}`;
  const out = redactSecrets(input);
  assert(!out.includes(nsec), 'nsec redacted');
  assert(!out.includes(bal), 'bal redacted');
});

test('redact: handles Error object (reads .stack)', () => {
  const bal = 'bal_' + 'y'.repeat(43);
  const err = new Error(`upstream failed: Bearer ${bal}`);
  const out = redactSecrets(err);
  assert(!out.includes(bal), 'balance token in Error.stack must be redacted');
});

test('redact: handles object via JSON.stringify', () => {
  const ns = 'nsec1' + 'c'.repeat(58);
  const out = redactSecrets({ nsec: ns, mode: 'cashu' });
  assert(!out.includes(ns), 'nsec in object must be redacted');
  assert(out.includes('cashu'), 'non-secret fields preserved');
});

test('redact: handles null and undefined safely', () => {
  assert(redactSecrets(null) === 'null', 'null → "null"');
  assert(redactSecrets(undefined) === 'undefined', 'undefined → "undefined"');
});

test('redact: leaves non-secret content unchanged', () => {
  const input = 'hello world, 1234 5678, path /v1/chat/completions';
  const out = redactSecrets(input);
  assert(out === input, 'no secrets = no change');
});

console.log('\n== Layer 2: BudgetTracker USDC cents rail ==\n');

test('BudgetTracker: reserveUsdcCents deducts from session', () => {
  const b = new BudgetTracker(500, 10_000, 5_000);
  b.reserveUsdcCents(100);
  assert(b.getSpentUsdcCents() === 100, 'spent == 100 cents');
  assert(b.getRemainingUsdcCents() === 4_900, 'remaining == 4900');
});

test('BudgetTracker: reserveUsdcCents rejects when session exhausted', () => {
  const b = new BudgetTracker(500, 10_000, 1_000);
  b.reserveUsdcCents(900);
  assertThrows(() => b.reserveUsdcCents(200), 'USDC budget exhausted');
});

test('BudgetTracker: reserveUsdcCents rejects zero/negative/fractional/NaN', () => {
  const b = new BudgetTracker(500, 10_000, 5_000);
  assertThrows(() => b.reserveUsdcCents(0), 'Invalid USDC cost');
  assertThrows(() => b.reserveUsdcCents(-1), 'Invalid USDC cost');
  assertThrows(() => b.reserveUsdcCents(1.5), 'Invalid USDC cost');
  assertThrows(() => b.reserveUsdcCents(NaN), 'Invalid USDC cost');
  assertThrows(() => b.reserveUsdcCents(Infinity), 'Invalid USDC cost');
});

test('BudgetTracker: releaseUsdcCents refunds', () => {
  const b = new BudgetTracker(500, 10_000, 5_000);
  b.reserveUsdcCents(300);
  b.releaseUsdcCents(300);
  assert(b.getSpentUsdcCents() === 0, 'refunded to zero');
});

test('BudgetTracker: USDC and sats rails are independent', () => {
  const b = new BudgetTracker(500, 10_000, 5_000);
  b.reserve(500);
  b.reserveUsdcCents(100);
  assert(b.getSpent() === 500, 'sats spent independent');
  assert(b.getSpentUsdcCents() === 100, 'USDC cents spent independent');
});

test('BudgetTracker: constructor rejects invalid USDC session limit', () => {
  assertThrows(() => new BudgetTracker(500, 10_000, 0), 'Invalid sessionBudgetUsdcCents');
  assertThrows(() => new BudgetTracker(500, 10_000, -1), 'Invalid sessionBudgetUsdcCents');
  assertThrows(() => new BudgetTracker(500, 10_000, 1.5), 'sessionBudgetUsdcCents must be integer');
  assertThrows(() => new BudgetTracker(500, 10_000, NaN), 'Invalid sessionBudgetUsdcCents');
});

console.log('\n== Layer 2: KNOWN_BROKEN_VERSIONS ==\n');

test('assertVersionNotBroken: does not throw for current version', () => {
  assertVersionNotBroken();
  assert(true, 'no throw');
});

test('KNOWN_BROKEN_VERSIONS: starts empty for v0.2.0 initial release', () => {
  assert(Array.isArray(KNOWN_BROKEN_VERSIONS), 'is array');
  assert(!KNOWN_BROKEN_VERSIONS.includes(PLUGIN_VERSION), 'current version not broken');
});

console.log('\n== Layer 2: config env resolvers ==\n');

test('resolveBaseUrl: default is production URL', () => {
  delete process.env.LLM402_BASE_URL_OVERRIDE;
  assert(resolveBaseUrl() === BASEURL_PROD, `expected ${BASEURL_PROD}`);
});

test('resolveBaseUrl: rejects HTTP override', () => {
  process.env.LLM402_BASE_URL_OVERRIDE = 'http://evil.example';
  try {
    assertThrows(() => resolveBaseUrl(), 'must be HTTPS');
  } finally {
    delete process.env.LLM402_BASE_URL_OVERRIDE;
  }
});

test('resolveBaseUrl: rejects private-IP override', () => {
  process.env.LLM402_BASE_URL_OVERRIDE = 'https://10.0.0.1';
  try {
    assertThrows(() => resolveBaseUrl(), 'private IPs');
  } finally {
    delete process.env.LLM402_BASE_URL_OVERRIDE;
  }
});

test('resolveBaseUrl: accepts valid HTTPS override', () => {
  process.env.LLM402_BASE_URL_OVERRIDE = 'https://llm402-staging.example.com';
  try {
    assert(resolveBaseUrl() === 'https://llm402-staging.example.com', 'override honored');
  } finally {
    delete process.env.LLM402_BASE_URL_OVERRIDE;
  }
});

test('resolveBaseRpcUrl: default is Base mainnet', () => {
  delete process.env.LLM402_BASE_RPC_URL_OVERRIDE;
  assert(resolveBaseRpcUrl() === BASE_RPC_URL_PROD, `expected ${BASE_RPC_URL_PROD}`);
});

test('resolveBaseRpcUrl: rejects non-allowlist override', () => {
  process.env.LLM402_BASE_RPC_URL_OVERRIDE = 'https://evil-rpc.example';
  try {
    assertThrows(() => resolveBaseRpcUrl(), 'not in allowlist');
  } finally {
    delete process.env.LLM402_BASE_RPC_URL_OVERRIDE;
  }
});

test('resolveBaseRpcUrl: accepts allowlist override', () => {
  process.env.LLM402_BASE_RPC_URL_OVERRIDE = 'https://base.llamarpc.com';
  try {
    assert(resolveBaseRpcUrl() === 'https://base.llamarpc.com', 'allowlisted override honored');
  } finally {
    delete process.env.LLM402_BASE_RPC_URL_OVERRIDE;
  }
});

// ====================== LAYER 9 ROUND-2 FIXES ======================

console.log('\n== Layer 9 Round 2: regression guards ==\n');

test('redact: bolt11 invoice (mainnet lnbc prefix)', () => {
  const invoice = 'lnbc100n1pwjhmhdpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdqqcqzpgxqyz5vq';
  const out = redactSecrets(`paid: ${invoice}`);
  assert(!out.includes(invoice), 'bolt11 must be redacted');
  assert(out.includes('ln[redacted]'), 'marker present');
});

test('redact: bolt11 invoice (testnet lntb prefix)', () => {
  const invoice = 'lntb100n1pwjhmhdpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdqqcqzpgxqyz5vq';
  const out = redactSecrets(`test: ${invoice}`);
  assert(!out.includes(invoice), 'testnet bolt11 must be redacted');
  assert(out.includes('ln[redacted]'), 'marker present');
});

test('default export: plugin entry has id, name, register', async () => {
  const entry = (await import('../src/index.js')).default;
  assert(typeof entry === 'object' && entry !== null, 'default export is an object');
  assert(entry.id === 'llm402-provider', `id == "llm402-provider", got "${(entry as any).id}"`);
  assert(entry.name === 'llm402.ai', 'name == "llm402.ai"');
  assert(typeof (entry as any).register === 'function', 'register is a function');
});

test('USDC reserve leak: orphaned reservation on sign failure is released', async () => {
  // Regression guard for the bug found in Layer 9 round 1:
  //   - signX402 called reserveUsdcCents BEFORE signing
  //   - x402CentsReserved was only set by caller AFTER signX402 returned
  //   - If signing threw, reservation was never released (budget leak)
  //
  // Round 2 fix: caller owns the reservation lifecycle. Reserve in caller
  // BEFORE calling signX402, release on any throw. This test exercises the
  // failure path with a bad payTo (causes signX402 to throw the validation
  // error) and asserts the session USDC budget is restored.
  const mockServer = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          price: 10,
          cashu: { price_sats: 10 },
          x402: {
            price_usd: 0.01,
            amount_atomic: '10000',
            pay_to: '0x0000000000000000000000000000000000BAD',  // bad payTo
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            network: 'base-mainnet',
          },
        }));
      });
    }
  });
  await new Promise<void>((resolve) => {
    mockServer.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (mockServer.address() as AddressInfo).port;

  const budget = new BudgetTracker(500, 10_000, 5_000);
  const budgetBeforeUsdc = budget.getRemainingUsdcCents();

  // Fake wallet: Cashu fails, x402 should then fail at payTo validation.
  const fakeWallet = {
    selectProofs: async () => { throw new Error('Mock: Cashu unavailable'); },
    getEvmPrivateKey: () => '0x' + '1'.repeat(64),
    meltForInvoice: async () => { throw new Error('Mock: L402 unavailable'); },
    addChangeProofs: async () => {},
    save: async () => {},
    init: async () => {},
  } as unknown as Llm402Wallet;

  const proxy = new PaymentProxy({
    targetUrl: `http://127.0.0.1:${port}`,
    wallet: fakeWallet,
    budget,
  });
  await proxy.start();

  try {
    const res = await fetch(`${proxy.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(res.status === 402, `all-payments-fail path must 402, got ${res.status}`);

    // CRITICAL: USDC cents budget must be restored. If this test fails,
    // the reservation leaked — the v0.2.0 regression returned.
    const budgetAfter = budget.getRemainingUsdcCents();
    assert(
      budgetAfter === budgetBeforeUsdc,
      `USDC budget leaked: before=${budgetBeforeUsdc}, after=${budgetAfter}`
    );
  } finally {
    await proxy.stop();
    mockServer.close();
  }
});

test('prepack script is declared (protects against stale build ship)', async () => {
  const fs = await import('fs');
  const pkg = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  );
  assert(typeof pkg.scripts.prepack === 'string', 'prepack script must be declared');
  assert(pkg.scripts.prepack.includes('clean'), 'prepack must run clean');
  assert(pkg.scripts.prepack.includes('build'), 'prepack must run build');
  assert(pkg.scripts.prepack.includes('verify:versions'), 'prepack must verify versions');
});

test('auth.fields has sessionBudgetUsdcCents (round-2 gap fix)', async () => {
  const fs = await import('fs');
  const man = JSON.parse(
    fs.readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8')
  );
  const fields = man.auth.fields as Array<{ key: string }>;
  const keys = fields.map((f) => f.key);
  assert(keys.includes('sessionBudgetUsdcCents'),
    `auth.fields missing sessionBudgetUsdcCents; has [${keys.join(', ')}]`);
});

test('resolveAuthConfig: prefers api.getAuthConfig()', async () => {
  const { resolveAuthConfig } = await import('../src/index.js');
  const api = {
    registerProvider: async () => {},
    getAuthConfig: () => ({ paymentMode: 'balance', balanceToken: 'from-getter' }),
    authConfig: { paymentMode: 'cashu', cashuNsec: 'from-property' },
  };
  const result = resolveAuthConfig(api as any);
  assert((result as any).balanceToken === 'from-getter', 'getter preferred over property');
});

test('resolveAuthConfig: falls back to api.authConfig property', async () => {
  const { resolveAuthConfig } = await import('../src/index.js');
  const api = {
    registerProvider: async () => {},
    authConfig: { paymentMode: 'balance', balanceToken: 'from-property' },
  };
  const result = resolveAuthConfig(api as any);
  assert((result as any).balanceToken === 'from-property', 'property used when no getter');
});

test('resolveAuthConfig: returns {} when both missing', async () => {
  const { resolveAuthConfig } = await import('../src/index.js');
  const api = { registerProvider: async () => {} };
  const result = resolveAuthConfig(api as any);
  assert(typeof result === 'object' && Object.keys(result).length === 0, 'empty fallback');
});

test('default export register(api) calls registerProvider with provider spec', async () => {
  // Smoke test that the modern entry-point actually wires through to
  // registerProvider. Uses balance mode with valid dummy credentials so
  // activate() succeeds and returns a provider; we assert the provider
  // spec is handed to api.registerProvider.
  const entry = (await import('../src/index.js')).default;
  let registeredProvider: any = null;
  const mockApi = {
    registerProvider: async (p: any) => { registeredProvider = p; },
    getAuthConfig: () => ({
      paymentMode: 'balance',
      balanceToken: 'bal_' + 'x'.repeat(43),
    }),
  };
  try {
    await (entry as any).register(mockApi);
    assert(registeredProvider !== null, 'registerProvider was called');
    assert(registeredProvider.providerId === 'llm402', `providerId == "llm402", got "${registeredProvider.providerId}"`);
    assert(typeof registeredProvider.models === 'function', 'models is callable');
    assert(typeof registeredProvider.shutdown === 'function', 'shutdown is callable');
    // Cleanup — shutdown the proxy the plugin started
    await registeredProvider.shutdown();
  } catch (err) {
    // If the plugin fails to activate in the test env (e.g., network),
    // we at least want to know register was attempted
    throw err;
  }
});

test('manifest has configSchema (JSON Schema for OpenClaw loader)', async () => {
  const fs = await import('fs');
  const man = JSON.parse(
    fs.readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8')
  );
  assert(typeof man.configSchema === 'object', 'configSchema must be an object');
  assert(man.configSchema.type === 'object', 'configSchema.type == "object"');
  assert(man.configSchema.additionalProperties === false, 'configSchema rejects unknown fields');
  assert(typeof man.configSchema.properties.paymentMode === 'object', 'paymentMode defined');
  assert(typeof man.configSchema.properties.sessionBudgetUsdcCents === 'object', 'sessionBudgetUsdcCents defined');
});

// ====================== RUN ALL TESTS ======================

async function run(): Promise<void> {
  for (const t of tests) {
    try {
      await t.fn();
      if (!(t.fn as any).__skipped) {
        console.log(`  PASS  ${t.name}`);
        passed++;
      }
    } catch (err) {
      if (err === '__SKIP__') continue; // skip marker
      console.log(`  FAIL  ${t.name}: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  console.log(`\n== Results: ${passed} passed, ${failed} failed, ${skipped} skipped ==\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
