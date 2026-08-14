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
import {
  verifyTemplate,
  verifyReplacement,
  TransactionRejected,
  type RailTemplate,
  type Intent,
} from "./transaction.js";
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
    template?: RailTemplate;
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

  /* Sign an issued template and submit the signature. A "superseded"
     response means an earlier bid for the same payment mined first; that is
     a settlement in progress, not a failure.

     Nothing is signed before the prepared transaction has been decoded and
     checked against the payment the caller asked for, and its hash
     recomputed here. The server proposes; the agent verifies. */
  private async submitSignature(
    id: string,
    signing: { template?: RailTemplate; template_hash?: `0x${string}`; submit?: string },
    intent: Intent,
    previous?: RailTemplate
  ): Promise<{ txHash: string; explorer: string }> {
    if (!this.signer) throw new ApiError(400, "A signer is required in the live environment.");
    if (!signing.template) {
      throw new TransactionRejected(
        "The server did not supply the unsigned transaction; this SDK will not sign a bare hash.",
        ["no template was returned alongside template_hash"]
      );
    }
    const decoded = verifyTemplate(signing.template, signing.template_hash!, intent);
    if (previous) verifyReplacement(previous, signing.template);
    if (!this.quiet) {
      console.log(
        `cartulary: verified before signing — ${decoded.amount} to ${decoded.recipient} via ${decoded.token} on ${decoded.chain} (nonce ${decoded.nonce})`
      );
    }
    const signature = await this.signer.sign(signing.template_hash!);
    const s = await this.request<{ status?: string; tx_hash: string; explorer: string }>(
      "POST",
      new URL(signing.submit!).pathname,
      { signature }
    );
    if (s.status === "superseded" && !this.quiet) {
      console.log(`cartulary: an earlier bid for ${id} mined first; awaiting its settled receipt`);
    }
    return { txHash: s.tx_hash, explorer: s.explorer };
  }

  /* Ask for a higher bid on a stale submission. Declined bumps (too early,
     attempts exhausted, already mined) are not errors; the wait continues. */
  private async tryBump(id: string, intent: Intent, previous: RailTemplate): Promise<void> {
    let b: { status: string; attempt?: number; template?: RailTemplate; template_hash?: `0x${string}`; submit?: string };
    try {
      b = await this.request("POST", `/api/v1/payments/${id}/bump`);
    } catch {
      return;
    }
    if (b.status !== "ready") return;
    if (!this.quiet) console.log(`cartulary: fee bump for ${id}, attempt ${b.attempt}; re-signing the same payment at a higher bid`);
    try {
      await this.submitSignature(id, b, intent, previous);
    } catch {
      /* The race resolved against the bump; the sweep settles the winner. */
    }
  }

  private async waitForSettlement(
    id: string,
    evidence: string,
    timeoutMs: number,
    bumpAfterMs = 60_000,
    bumpContext?: { intent: Intent; template: RailTemplate }
  ): Promise<SettledResult> {
    const deadline = Date.now() + timeoutMs;
    let staleSince = Date.now();
    for (;;) {
      const s = await this.paymentState(id);
      if (bumpContext && s.submission?.status === "submitted" && Date.now() - staleSince > bumpAfterMs) {
        await this.tryBump(id, bumpContext.intent, bumpContext.template);
        staleSince = Date.now();
      }
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
    const decisionBody = {
      amount,
      currency: input.currency ?? "USD",
      instrument,
      agent: this.agentName,
      counterparty: to,
      idempotency_key: idempotencyKey,
    };
    const d = await this.request<DecisionResponse>("POST", "/api/v1/decisions", decisionBody);
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

    /* What the caller actually asked for. Every prepared transaction is
       checked against this before the key is used. */
    const intent: Intent = { recipient: to.address!, amount };

    let sub: { txHash: string; explorer: string };
    try {
      sub = await this.submitSignature(id, signing, intent);
    } catch (err) {
      if (!(err instanceof TemplateExpiredError)) throw err;
      /* Self-heal: the same idempotency key replays the same payment, and
         the server reissues a fresh template for it, receipted as a further
         prepared attempt. A second payment cannot exist. */
      if (!this.quiet) console.log(`cartulary: the template for ${id} expired; reissuing for the same payment`);
      const d2 = await this.request<DecisionResponse>("POST", "/api/v1/decisions", decisionBody);
      if (d2.signing?.status !== "ready") {
        throw new SettlementUnavailableError(
          d2.signing?.reason ?? "The template could not be reissued; decide afresh.",
          id
        );
      }
      sub = await this.submitSignature(id, d2.signing, intent);
      signing.template = d2.signing.template;
    }

    if (!wait) return this.asSubmitted(id, evidence, sub.txHash, sub.explorer, d.replayed);
    return this.waitForSettlement(id, evidence, timeoutMs, input.bumpAfterMs, {
      intent,
      template: signing.template!,
    });
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

  /*
    The complete evidence bundle for a payment: every receipt with every
    field its hash binds, so it can be recomputed by the published verifier
    without asking Cartulary what it contains. Write it to a file and run
    `node verify.mjs bundle.json`.
  */
  async evidenceBundle(id: string): Promise<{
    payment: Record<string, unknown>;
    receipts: Receipt[];
    verification: { method: string; verifier: string };
  }> {
    const s = await this.paymentState(id);
    return {
      payment: { id, ...(s.payment as Record<string, unknown>) },
      receipts: s.receipts,
      verification: {
        method: "SHA-256 over RFC 8785 canonical JSON of {actor, env, event_type, payload, payment_id, prev_hash, seq}",
        verifier: "https://github.com/prasants/cartulary/blob/main/verify.mjs",
      },
    };
  }
}
