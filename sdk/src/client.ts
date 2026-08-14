import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { FileSigner, type Signer } from "./signer.js";
import {
  ApiError,
  AuthError,
  RateLimitError,
  RefusedError,
  SettlementError,
  SettlementUnavailableError,
  TemplateExpiredError,
  VerificationError,
} from "./errors.js";
import type {
  CartularyOptions,
  HeldResult,
  PayInput,
  PayResult,
  Receipt,
  SettledResult,
  WalletInfo,
} from "./types.js";

/*
  The client wraps one loop: decide, sign, submit, settle. The server holds
  the policy, builds the transaction, and relays it; this SDK holds only the
  key. It makes no chain RPC calls at all: an agent needs an API key and a
  signer, nothing else.
*/

const DEFAULT_BASE = "https://www.cartulary.xyz";
const RAIL_INSTRUMENT = "usdc-base";

function normaliseAmount(amount: string | number): string {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e13) {
      throw new ApiError(400, `amount ${amount} is not a positive finite number.`);
    }
    const s = amount.toFixed(6);
    if (Math.abs(parseFloat(s) - amount) > 1e-9) {
      throw new ApiError(400, `amount ${amount} has more than six decimal places; pass a string.`);
    }
    return s;
  }
  const m = /^(\d{1,13})(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!m) {
    throw new ApiError(400, `amount "${amount}" must be a decimal like "1.50" with at most six decimals.`);
  }
  return `${m[1]}.${(m[2] ?? "").padEnd(6, "0")}`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface DecisionResponse {
  decision: "allow" | "hold" | "refuse";
  reasons: string[];
  environment: "simulated" | "live";
  replayed?: boolean;
  payment: { id: string; state: string };
  receipts: Receipt[];
  signing: {
    status: "ready" | "unavailable" | "submitted" | "confirmed";
    template_hash?: `0x${string}`;
    submit?: string;
    expires_at?: string;
    funding?: string | null;
    reason?: string;
    tx_hash?: string;
    explorer?: string;
  } | null;
  links: { evidence: string };
}

export class Cartulary {
  private readonly apiKey: string;
  private readonly agentName: string;
  private readonly base: string;
  private readonly quiet: boolean;
  readonly sandbox: boolean;
  readonly signer: Signer | null;
  private bound: string | null = null;

  constructor(opts: CartularyOptions) {
    if (!opts?.apiKey) throw new AuthError("An apiKey is required.");
    if (!opts.agent) throw new ApiError(400, "agent is required: the registered agent this process acts as.");
    this.apiKey = opts.apiKey;
    this.agentName = opts.agent;
    this.base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    if (!/^https:/.test(this.base) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(this.base)) {
      throw new ApiError(400, "baseUrl must be https (plain http is allowed for localhost only).");
    }
    this.sandbox = opts.apiKey.startsWith("ck_test_");
    this.quiet = opts.quiet ?? false;
    this.signer = this.sandbox
      ? (opts.signer ?? null)
      : (opts.signer ?? new FileSigner(opts.keyfile ?? join(".cartulary", `${opts.agent}.key`)));
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ApiError(0, `Could not reach ${this.base}: ${(err as Error).message}`);
    }
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, `Unexpected non-JSON response (${res.status}).`);
    }
    if (!res.ok) {
      const msg = String(json.error ?? `Request failed (${res.status}).`);
      if (res.status === 401) throw new AuthError(msg);
      if (res.status === 429) throw new RateLimitError(msg);
      if (res.status === 410) throw new TemplateExpiredError();
      if (res.status === 422 && /recover/.test(msg)) throw new VerificationError(msg);
      if (res.status === 502) throw new SettlementError(msg, { fix: msg.includes("Fund") ? msg : undefined });
      throw new ApiError(res.status, msg);
    }
    return json as T;
  }

  /** The agent's bound wallet and balances, from Cartulary; no RPC required. */
  async wallet(): Promise<WalletInfo> {
    if (this.sandbox) {
      return { agent: this.agentName, address: null, note: "The simulated environment settles without a wallet." };
    }
    return this.request<WalletInfo>("GET", `/api/v1/agents/wallet?agent=${encodeURIComponent(this.agentName)}`);
  }

  /* Binding is write-once: the first run generates a key, binds its address,
     and says so once. Every later run verifies the local signer still matches
     the bound wallet, so a drifted key fails loudly, not at relay time. */
  private async ensureBound(): Promise<void> {
    if (this.sandbox || this.bound) return;
    if (!this.signer) throw new ApiError(400, "A signer is required in the live environment.");
    const local = await this.signer.address();
    const info = await this.wallet();
    if (!info.address) {
      await this.request("PUT", "/api/v1/agents/wallet", { agent: this.agentName, address: local });
      this.bound = local;
      if (!this.quiet) {
        const after = await this.wallet();
        const file = this.signer instanceof FileSigner ? this.signer.path : "(custom signer)";
        console.log(
          [
            `cartulary: new wallet bound to ${this.agentName} (write-once)`,
            `  address  ${local}`,
            `  keyfile  ${file}`,
            `  fund it  gas: ${after.faucets?.eth ?? "see docs"}`,
            `           test USDC: ${after.faucets?.usdc ?? "see docs"}`,
          ].join("\n")
        );
      }
      return;
    }
    if (info.address.toLowerCase() !== local.toLowerCase()) {
      throw new VerificationError(
        `The local signer is ${local} but ${this.agentName} is bound to ${info.address}.`
      );
    }
    this.bound = info.address;
  }

  private async paymentState(id: string): Promise<{
    payment: { state: string };
    receipts: Receipt[];
    submission: { status: string; tx_hash: string | null; explorer: string | null } | null;
    links: { evidence: string };
  }> {
    return this.request("GET", `/api/v1/payments/${id}`);
  }

  private async waitForSettlement(id: string, evidence: string, timeoutMs: number): Promise<SettledResult> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.paymentState(id);
      if (s.payment.state === "settled") {
        const settled = s.receipts.find((r) => r.event_type === "settled");
        const payload = (settled?.payload ?? {}) as { tx_hash?: string; explorer?: string };
        return {
          status: "settled",
          id,
          txHash: payload.tx_hash ?? s.submission?.tx_hash ?? "",
          explorer: payload.explorer ?? s.submission?.explorer ?? "",
          evidence,
          receipts: s.receipts,
        };
      }
      const failed = s.receipts.find((r) => r.event_type === "settlement_failed");
      if (failed) {
        const reason = String((failed.payload as { reason?: string })?.reason ?? "Settlement failed.");
        throw new SettlementError(reason, { paymentId: id, fix: /fund/i.test(reason) ? reason : undefined });
      }
      if (Date.now() > deadline) {
        throw new SettlementError(
          `Still awaiting confirmation after ${Math.round(timeoutMs / 1000)}s; the payment stands and settles when the chain confirms.`,
          { paymentId: id, fix: `Check ${evidence} or call payment("${id}") later; nothing needs re-sending.` }
        );
      }
      await sleep(4000);
    }
  }

  /** One payment, end to end: decided, signed, submitted, settled, receipted. */
  async pay(input: PayInput): Promise<PayResult> {
    const amount = normaliseAmount(input.amount);
    const to =
      typeof input.to === "string"
        ? /^0x[0-9a-fA-F]{40}$/.test(input.to)
          ? { name: input.to, address: input.to }
          : { name: input.to }
        : input.to;
    if (!to.name) throw new ApiError(400, "to requires a counterparty name or 0x… address.");
    const instrument = input.instrument ?? RAIL_INSTRUMENT;
    const wantsRail = !this.sandbox && instrument === RAIL_INSTRUMENT && !!to.address;
    if (wantsRail) await this.ensureBound();

    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    const d = await this.request<DecisionResponse>("POST", "/api/v1/decisions", {
      amount,
      currency: input.currency ?? "USD",
      instrument,
      agent: this.agentName,
      counterparty: to,
      idempotency_key: idempotencyKey,
    });
    const evidence = d.links.evidence;
    const id = d.payment.id;

    if (d.decision === "refuse") {
      throw new RefusedError({ paymentId: id, evidence, reasons: d.reasons });
    }
    if (d.decision === "hold") {
      const held: HeldResult = {
        status: "held",
        id,
        evidence,
        replayed: d.replayed,
        reason: d.reasons[0] ?? "Held for human review.",
        wait: async (opts) => {
          const deadline = Date.now() + (opts?.timeoutMs ?? 15 * 60 * 1000);
          for (;;) {
            const s = await this.paymentState(id);
            if (s.payment.state !== "held") {
              if (s.payment.state === "refused") {
                throw new RefusedError({ paymentId: id, evidence, reasons: ["The hold was resolved as blocked."] });
              }
              return { state: s.payment.state, evidence };
            }
            if (Date.now() > deadline) return { state: "held", evidence };
            await sleep(5000);
          }
        },
      };
      return held;
    }

    /* Allowed. */
    if (this.sandbox || d.environment === "simulated") {
      return { status: "simulated", id, evidence, receipts: d.receipts, replayed: d.replayed };
    }

    const signing = d.signing;
    const wait = input.wait ?? true;
    const timeoutMs = input.timeoutMs ?? 120_000;

    if (!wantsRail) {
      /* Decision recorded, nothing to settle: surface that honestly. */
      throw new SettlementUnavailableError(
        signing?.reason ??
          (instrument !== RAIL_INSTRUMENT
            ? `Only ${RAIL_INSTRUMENT} settles on the rail today; the ${instrument} decision is receipted but nothing moves.`
            : "The counterparty has no wallet address; the decision is receipted but nothing settles. Pass to: '0x…'."),
        id
      );
    }
    if (!signing || signing.status === "unavailable") {
      throw new SettlementUnavailableError(signing?.reason ?? "No signing template was issued.", id);
    }
    if (signing.status === "submitted" || signing.status === "confirmed") {
      /* An idempotent replay of a payment already on chain. */
      const submitted = this.asSubmitted(id, evidence, signing.tx_hash ?? "", signing.explorer ?? "", true);
      return wait ? this.waitForSettlement(id, evidence, timeoutMs) : submitted;
    }

    if (!this.signer) throw new ApiError(400, "A signer is required in the live environment.");
    const signature = await this.signer.sign(signing.template_hash!);
    const submitPath = new URL(signing.submit!).pathname;
    const s = await this.request<{ tx_hash: string; explorer: string }>("POST", submitPath, { signature });

    if (!wait) return this.asSubmitted(id, evidence, s.tx_hash, s.explorer, d.replayed);
    return this.waitForSettlement(id, evidence, timeoutMs);
  }

  private asSubmitted(id: string, evidence: string, txHash: string, explorer: string, replayed?: boolean) {
    return {
      status: "submitted" as const,
      id,
      evidence,
      txHash,
      explorer,
      replayed,
      wait: (opts?: { timeoutMs?: number }) =>
        this.waitForSettlement(id, evidence, opts?.timeoutMs ?? 120_000),
    };
  }

  /** Fetch any payment's state and receipt chain by id. */
  async payment(id: string) {
    return this.paymentState(id);
  }
}
