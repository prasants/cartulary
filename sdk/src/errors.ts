/*
  Every error an agent can meet has a name, and where the situation has a
  remedy, the error carries it as `fix`. Refusals are errors by design: a
  refused payment is not a result to branch on quietly, it is a governed
  outcome an agent's operator should see.
*/

export class CartularyError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly fix?: string;

  constructor(code: string, message: string, opts: { status?: number; fix?: string } = {}) {
    super(message);
    this.name = "CartularyError";
    this.code = code;
    this.status = opts.status;
    this.fix = opts.fix;
  }
}

export class AuthError extends CartularyError {
  constructor(message: string) {
    super("auth", message, {
      status: 401,
      fix: "Check the API key. Live keys are issued in the console at cartulary.xyz/console.",
    });
    this.name = "AuthError";
  }
}

export class RateLimitError extends CartularyError {
  constructor(message: string) {
    super("rate_limit", message, { status: 429, fix: "Back off and retry after a minute." });
    this.name = "RateLimitError";
  }
}

/* The control plane said no, and receipted why. */
export class RefusedError extends CartularyError {
  readonly paymentId: string;
  readonly evidence: string;
  readonly reasons: string[];

  constructor(input: { paymentId: string; evidence: string; reasons: string[] }) {
    super("refused", input.reasons[0] ?? "The payment was refused.", {
      status: 200,
      fix: "The refusal is receipted; see the evidence link. Adjust the mandate or policy in the console if the refusal is wrong.",
    });
    this.name = "RefusedError";
    this.paymentId = input.paymentId;
    this.evidence = input.evidence;
    this.reasons = input.reasons;
  }
}

/* The decision allowed the payment but no transaction could be issued. */
export class SettlementUnavailableError extends CartularyError {
  readonly paymentId?: string;

  constructor(reason: string, paymentId?: string) {
    const inFlight = /in flight/i.test(reason);
    super("settlement_unavailable", reason, {
      fix: inFlight
        ? "One payment per agent may be in flight. Wait for it to settle, then retry with a new idempotency key."
        : reason.includes("counterparty")
          ? "Pass to: '0x…' or to: { name, address } so the rail knows where to send funds."
          : undefined,
    });
    this.name = "SettlementUnavailableError";
    this.paymentId = paymentId;
  }
}

export class TemplateExpiredError extends CartularyError {
  constructor() {
    super("template_expired", "The signing template expired before the signature arrived.", {
      status: 410,
      fix: "Call pay() again with a new idempotency key; policy is re-evaluated and a fresh template issues.",
    });
    this.name = "TemplateExpiredError";
  }
}

export class VerificationError extends CartularyError {
  constructor(message: string) {
    super("verification_failed", message, {
      status: 422,
      fix: "The signature did not recover to the bound wallet. If you rotated keys, rebinding is a governed console action.",
    });
    this.name = "VerificationError";
  }
}

export class SettlementError extends CartularyError {
  readonly paymentId?: string;

  constructor(message: string, opts: { paymentId?: string; fix?: string } = {}) {
    super("settlement_failed", message, { status: 502, fix: opts.fix });
    this.name = "SettlementError";
    this.paymentId = opts.paymentId;
  }
}

export class ApiError extends CartularyError {
  constructor(status: number, message: string) {
    super("api", message, { status });
    this.name = "ApiError";
  }
}
