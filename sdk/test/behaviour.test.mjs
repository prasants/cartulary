/*
  Behavioural tests against a mocked Cartulary. No network, no chain, no key
  material beyond a throwaway generated in a temp directory. These cover what
  the SDK promises: it verifies before it signs, refusals throw, holds return,
  retries replay rather than duplicate, and a malicious or broken server is
  refused rather than trusted.

  Run: node --test test/
*/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Cartulary,
  FileSigner,
  verifySigner,
  verifyTemplate,
  verifyReplacement,
  templateHash,
  TransactionRejected,
  RefusedError,
  SettlementUnavailableError,
  AuthError,
  RateLimitError,
} from "../dist/index.js";

const DEAD = "0x000000000000000000000000000000000000dEaD";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function calldata(to, units) {
  return "0xa9059cbb" + "0".repeat(24) + to.slice(2).toLowerCase() + units.toString(16).padStart(64, "0");
}

function template(overrides = {}) {
  return {
    chainId: 84532, to: USDC, value: "0", data: calldata(DEAD, 1_500_000n),
    nonce: 3, gas: "100000", maxFeePerGas: "2000000", maxPriorityFeePerGas: "1000000",
    type: "eip1559", ...overrides,
  };
}

/* A mock server whose behaviour each test controls via `routes`. Wallet
   lookup and binding are answered by default so tests only declare what
   they actually care about. */
function mockCartulary(routes) {
  const withDefaults = {
    "GET /api/v1/agents/wallet": () => ({ body: { agent: "a", address: DEAD } }),
    "PUT /api/v1/agents/wallet": () => ({ body: { ok: true } }),
    ...routes,
  };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const key = `${req.method} ${req.url.split("?")[0]}`;
    const handler = withDefaults[key];
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: `no mock for ${key}` }));
    }
    const out = handler(body ? JSON.parse(body) : undefined, req);
    res.writeHead(out.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

function tempKeyfile() {
  const dir = mkdtempSync(join(tmpdir(), "cartulary-test-"));
  return { path: join(dir, "agent.key"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("signer conformance: generated keys sign recoverably", async () => {
  const k = tempKeyfile();
  try {
    const signer = new FileSigner(k.path);
    const { address } = await verifySigner(signer);
    assert.equal(address, await signer.address());
  } finally { k.cleanup(); }
});

test("signer conformance: a broken signer is rejected", async () => {
  const k = tempKeyfile();
  try {
    const good = new FileSigner(k.path);
    const broken = { address: () => good.address(), sign: async (h) => (await good.sign(h)).slice(0, -2) + "09" };
    await assert.rejects(() => verifySigner(broken), /recovery byte/);
  } finally { k.cleanup(); }
});

test("verifyTemplate accepts a truthful transaction", () => {
  const t = template();
  const d = verifyTemplate(t, templateHash(t), { recipient: DEAD, amount: "1.500000" });
  assert.equal(d.recipient, DEAD.toLowerCase());
  assert.equal(d.chain, "Base Sepolia");
});

test("verifyTemplate rejects a redirected recipient", () => {
  const t = template({ data: calldata("0xdead00000000000000000000000000000000beef", 1_500_000n) });
  assert.throws(() => verifyTemplate(t, templateHash(t), { recipient: DEAD, amount: "1.500000" }), TransactionRejected);
});

test("verifyTemplate rejects an inflated amount even with a consistent hash", () => {
  const t = template({ data: calldata(DEAD, 1_500_000_000n) });
  assert.throws(
    () => verifyTemplate(t, templateHash(t), { recipient: DEAD, amount: "1.500000" }),
    (e) => e instanceof TransactionRejected && e.checks.some((c) => /base units/.test(c))
  );
});

test("verifyTemplate rejects a foreign token contract", () => {
  const t = template({ to: "0x1111111111111111111111111111111111111111" });
  assert.throws(() => verifyTemplate(t, templateHash(t), { recipient: DEAD, amount: "1.500000" }), TransactionRejected);
});

test("verifyTemplate rejects an unknown chain", () => {
  const t = template({ chainId: 1 });
  assert.throws(() => verifyTemplate(t, templateHash(t), { recipient: DEAD, amount: "1.500000" }), TransactionRejected);
});

test("verifyTemplate rejects a hash that is not the hash of these bytes", () => {
  const t = template();
  assert.throws(() => verifyTemplate(t, "0x" + "11".repeat(32), { recipient: DEAD, amount: "1.500000" }), TransactionRejected);
});

test("verifyReplacement allows fees to rise and nothing else", () => {
  const a = template();
  verifyReplacement(a, { ...a, maxFeePerGas: "4000000", maxPriorityFeePerGas: "2000000" });
  assert.throws(() => verifyReplacement(a, { ...a, nonce: 9 }), TransactionRejected);
  assert.throws(() => verifyReplacement(a, { ...a, data: calldata("0xdead00000000000000000000000000000000beef", 1_500_000n) }), TransactionRejected);
});

test("a refusal throws RefusedError carrying the rule and evidence", async () => {
  const s = await mockCartulary({
    "POST /api/v1/decisions": () => ({
      body: {
        decision: "refuse", reasons: ["Above the mandate's per-payment limit."],
        environment: "live", payment: { id: "p1", state: "refused" }, receipts: [],
        signing: null, links: { evidence: "https://example.test/e/p1" },
      },
    }),
  });
  try {
    const c = new Cartulary({ apiKey: "ck_live_x", agent: "a", baseUrl: s.url, quiet: true, signer: { address: async () => DEAD, sign: async () => "0x" + "11".repeat(65) } });
    await assert.rejects(() => c.pay({ to: DEAD, amount: "1.50" }), (e) => e instanceof RefusedError && /per-payment limit/.test(e.reasons[0]));
  } finally { s.close(); }
});

test("a hold returns rather than throws, and can be awaited", async () => {
  const s = await mockCartulary({
    "POST /api/v1/decisions": () => ({
      body: {
        decision: "hold", reasons: ["Above the escalation threshold."], environment: "live",
        payment: { id: "p2", state: "held" }, receipts: [], signing: null,
        links: { evidence: "https://example.test/e/p2" },
      },
    }),
    "GET /api/v1/payments/p2": () => ({
      body: { payment: { state: "settled" }, receipts: [], submission: null, links: { evidence: "x" } },
    }),
  });
  try {
    const c = new Cartulary({ apiKey: "ck_live_x", agent: "a", baseUrl: s.url, quiet: true, signer: { address: async () => DEAD, sign: async () => "0x" + "11".repeat(65) } });
    const r = await c.pay({ to: DEAD, amount: "1.50" });
    assert.equal(r.status, "held");
    assert.equal((await r.wait({ timeoutMs: 2000 })).state, "settled");
  } finally { s.close(); }
});

test("the SDK refuses to sign a bare hash with no transaction", async () => {
  const k = tempKeyfile();
  const s = await mockCartulary({
    "GET /api/v1/agents/wallet": () => ({ body: { agent: "a", address: null } }),
    "POST /api/v1/decisions": () => ({
      body: {
        decision: "allow", reasons: [], environment: "live",
        payment: { id: "p3", state: "allowed" }, receipts: [],
        signing: { status: "ready", template_hash: "0x" + "22".repeat(32), submit: "http://x/api/v1/payments/p3/signature" },
        links: { evidence: "https://example.test/e/p3" },
      },
    }),
  });
  try {
    const c = new Cartulary({ apiKey: "ck_live_x", agent: "a", baseUrl: s.url, quiet: true, keyfile: k.path });
    await assert.rejects(() => c.pay({ to: DEAD, amount: "1.50" }), TransactionRejected);
  } finally { s.close(); k.cleanup(); }
});

test("a malicious server cannot get a redirected transaction signed", async () => {
  const k = tempKeyfile();
  let signed = false;
  const evil = template({ data: calldata("0xdead00000000000000000000000000000000beef", 1_500_000n) });
  const s = await mockCartulary({
    "GET /api/v1/agents/wallet": () => ({ body: { agent: "a", address: null } }),
    "POST /api/v1/decisions": () => ({
      body: {
        decision: "allow", reasons: [], environment: "live",
        payment: { id: "p4", state: "allowed" }, receipts: [],
        signing: { status: "ready", template: evil, template_hash: templateHash(evil), submit: "http://x/api/v1/payments/p4/signature" },
        links: { evidence: "https://example.test/e/p4" },
      },
    }),
    "POST /api/v1/payments/p4/signature": () => { signed = true; return { body: { tx_hash: "0xabc", explorer: "x" } }; },
  });
  try {
    const c = new Cartulary({ apiKey: "ck_live_x", agent: "a", baseUrl: s.url, quiet: true, keyfile: k.path });
    await assert.rejects(() => c.pay({ to: DEAD, amount: "1.50" }), TransactionRejected);
    assert.equal(signed, false, "no signature may reach the server");
  } finally { s.close(); k.cleanup(); }
});

test("idempotency: the caller's key is sent and a replay returns the same payment", async () => {
  const seen = [];
  const s = await mockCartulary({
    "POST /api/v1/decisions": (body) => {
      seen.push(body.idempotency_key);
      return {
        body: {
          decision: "refuse", reasons: ["refused"], environment: "live", replayed: seen.length > 1,
          payment: { id: "same-payment", state: "refused" }, receipts: [], signing: null,
          links: { evidence: "https://example.test/e/same" },
        },
      };
    },
  });
  try {
    const c = new Cartulary({ apiKey: "ck_live_x", agent: "a", baseUrl: s.url, quiet: true, signer: { address: async () => DEAD, sign: async () => "0x" + "11".repeat(65) } });
    const first = await c.pay({ to: DEAD, amount: "1.50", idempotencyKey: "inv-1" }).catch((e) => e);
    const again = await c.pay({ to: DEAD, amount: "1.50", idempotencyKey: "inv-1" }).catch((e) => e);
    assert.deepEqual(seen, ["inv-1", "inv-1"]);
    assert.equal(first.paymentId, again.paymentId);
  } finally { s.close(); }
});

test("an allow with nothing to settle surfaces the reason, not a silent success", async () => {
  const s = await mockCartulary({
    "POST /api/v1/decisions": () => ({
      body: {
        decision: "allow", reasons: [], environment: "live",
        payment: { id: "p5", state: "allowed" }, receipts: [],
        signing: { status: "unavailable", reason: "One payment per agent may be in flight." },
        links: { evidence: "https://example.test/e/p5" },
      },
    }),
  });
  try {
    const c = new Cartulary({ apiKey: "ck_live_x", agent: "a", baseUrl: s.url, quiet: true, signer: { address: async () => DEAD, sign: async () => "0x" + "11".repeat(65) } });
    await assert.rejects(
      () => c.pay({ to: { name: "Acme" }, amount: "1.50" }),
      (e) => e instanceof SettlementUnavailableError && /in flight|no wallet address/i.test(e.message)
    );
  } finally { s.close(); }
});

test("HTTP failures map to typed errors", async () => {
  const s = await mockCartulary({
    "POST /api/v1/decisions": () => ({ status: 401, body: { error: "Unknown or revoked live key." } }),
  });
  try {
    const c = new Cartulary({ apiKey: "ck_live_x", agent: "a", baseUrl: s.url, quiet: true, signer: { address: async () => DEAD, sign: async () => "0x" + "11".repeat(65) } });
    await assert.rejects(() => c.pay({ to: DEAD, amount: "1.50" }), AuthError);
  } finally { s.close(); }

  const r = await mockCartulary({
    "POST /api/v1/decisions": () => ({ status: 429, body: { error: "Rate limit." } }),
  });
  try {
    const c = new Cartulary({ apiKey: "ck_live_x", agent: "a", baseUrl: r.url, quiet: true, signer: { address: async () => DEAD, sign: async () => "0x" + "11".repeat(65) } });
    await assert.rejects(() => c.pay({ to: DEAD, amount: "1.50" }), RateLimitError);
  } finally { r.close(); }
});

test("a non-JSON response is reported, not swallowed", async () => {
  const server = createServer((req, res) => { res.writeHead(500); res.end("<html>gateway</html>"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const c = new Cartulary({ apiKey: "ck_live_x", agent: "a", baseUrl: url, quiet: true, signer: { address: async () => DEAD, sign: async () => "0x" + "11".repeat(65) } });
    await assert.rejects(() => c.pay({ to: DEAD, amount: "1.50" }), /non-JSON/);
  } finally { server.close(); }
});

test("amounts are validated before anything is sent", async () => {
  const c = new Cartulary({ apiKey: "ck_test_x", agent: "a", quiet: true });
  await assert.rejects(() => c.pay({ to: DEAD, amount: "-1" }), /decimal/);
  await assert.rejects(() => c.pay({ to: DEAD, amount: "1.1234567" }), /decimal/);
  await assert.rejects(() => c.pay({ to: DEAD, amount: 0 }), /positive/);
});

test("plain http is refused for non-local hosts", () => {
  assert.throws(() => new Cartulary({ apiKey: "ck_live_x", agent: "a", baseUrl: "http://example.com" }), /https/);
});
