export interface CartularyOptions {
  /** Your API key: ck_live_… for a live organisation, ck_test_… for the simulated one. */
  apiKey: string;
  /** The registered agent this process acts as. */
  agent: string;
  /** Override the API origin; defaults to https://www.cartulary.xyz. */
  baseUrl?: string;
  /** Bring your own signer (KMS, HSM, MPC). Defaults to a local key file. */
  signer?: import("./signer.js").Signer;
  /** Path for the default file signer; defaults to ./.cartulary/<agent>.key. */
  keyfile?: string;
  /** Suppress the one-time first-run message. */
  quiet?: boolean;
}

export interface PayInput {
  /** A 0x… address, or { name, address? }. Without an address the decision is recorded but nothing settles. */
  to: string | { name: string; address?: string };
  /** Decimal string, e.g. "1.50". Strings avoid floating-point money; numbers are accepted and converted exactly when safe. */
  amount: string | number;
  /** Defaults to USD. */
  currency?: string;
  /** Defaults to usdc-base, the testnet rail. */
  instrument?: string;
  /** Supply your own to make retries safe across processes; one is generated per call otherwise. */
  idempotencyKey?: string;
  /** Wait for on-chain settlement (default true). false returns as soon as the transaction is submitted. */
  wait?: boolean;
  /** How long to wait for settlement before returning the submitted state. Default 120000. */
  timeoutMs?: number;
}

export interface Receipt {
  seq: number;
  event_type: string;
  actor: string;
  payload?: unknown;
  prev_hash: string | null;
  hash: string;
}

interface PayBase {
  /** The payment's id at Cartulary. */
  id: string;
  /** The evidence page for this payment's receipt chain. Live pages are visible to your organisation's members; simulated pages are public. */
  evidence: string;
  /** True when an idempotency key replayed an earlier decision instead of creating a payment. */
  replayed?: boolean;
}

export interface SettledResult extends PayBase {
  status: "settled";
  txHash: string;
  explorer: string;
  receipts: Receipt[];
}

export interface SubmittedResult extends PayBase {
  status: "submitted";
  txHash: string;
  explorer: string;
  /** Poll until the settled receipt is written on chain confirmation. */
  wait(opts?: { timeoutMs?: number }): Promise<SettledResult>;
}

export interface HeldResult extends PayBase {
  status: "held";
  reason: string;
  /** Poll while a human decides in the console. Resolves with the payment's terminal state. */
  wait(opts?: { timeoutMs?: number }): Promise<{ state: string; evidence: string }>;
}

export interface SimulatedResult extends PayBase {
  status: "simulated";
  receipts: Receipt[];
}

export type PayResult = SettledResult | SubmittedResult | HeldResult | SimulatedResult;

export interface WalletInfo {
  agent: string;
  address: string | null;
  chain?: string;
  balances?: { eth: string; usdc: string };
  explorer?: string;
  faucets?: { eth: string; usdc: string };
  note?: string;
}
