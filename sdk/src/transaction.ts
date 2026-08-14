import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils";

/*
  Gate two, on the agent's side.

  The server prepares the transaction; the agent must not take its word for
  what those bytes do. This module decodes the prepared transaction, checks
  it against the payment the caller actually asked for, and recomputes the
  signing hash independently. Only a transaction that survives all of it is
  ever signed. A server that returned a template paying somewhere else, in a
  different amount, in a different token, or on a different chain, is caught
  here rather than trusted.

  The chain registry is deliberately hardcoded. Validating server-supplied
  bytes against server-supplied expectations would prove nothing.
*/

export interface RailTemplate {
  chainId: number;
  to: string;
  value: string;
  data: string;
  nonce: number;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  type: string;
}

interface ChainRules {
  name: string;
  token: string;
  decimals: number;
}

/* Known chains and the only token contract the SDK will pay through. */
export const CHAINS: Record<number, ChainRules> = {
  84532: {
    name: "Base Sepolia",
    token: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    decimals: 6,
  },
};

const ERC20_TRANSFER = "a9059cbb";

/* Minimal RLP. Integers are minimal big-endian; zero is the empty string. */
function rlpLength(len: number, offset: number): Uint8Array {
  if (len < 56) return Uint8Array.from([offset + len]);
  const hex = len.toString(16);
  const lenBytes = hexToBytes(hex.length % 2 ? "0" + hex : hex);
  return concatBytes(Uint8Array.from([offset + 55 + lenBytes.length]), lenBytes);
}

function rlpEncode(input: Uint8Array | Uint8Array[]): Uint8Array {
  if (Array.isArray(input)) {
    const payload = concatBytes(...input.map((i) => rlpEncode(i)));
    return concatBytes(rlpLength(payload.length, 0xc0), payload);
  }
  if (input.length === 1 && input[0] < 0x80) return input;
  return concatBytes(rlpLength(input.length, 0x80), input);
}

function toBytes(value: string | number): Uint8Array {
  const n = typeof value === "number" ? BigInt(value) : BigInt(value);
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return hexToBytes(hex);
}

function hexBytes(value: string): Uint8Array {
  const clean = value.toLowerCase().replace(/^0x/, "");
  return clean.length === 0 ? new Uint8Array(0) : hexToBytes(clean.length % 2 ? "0" + clean : clean);
}

/*
  EIP-1559 payload: 0x02 || rlp([chainId, nonce, maxPriorityFeePerGas,
  maxFeePerGas, gas, to, value, data, accessList]).
*/
export function templateHash(t: RailTemplate): string {
  const serialised = concatBytes(
    Uint8Array.from([0x02]),
    rlpEncode([
      toBytes(t.chainId),
      toBytes(t.nonce),
      toBytes(t.maxPriorityFeePerGas),
      toBytes(t.maxFeePerGas),
      toBytes(t.gas),
      hexBytes(t.to),
      toBytes(t.value),
      hexBytes(t.data),
      [] as unknown as Uint8Array,
    ])
  );
  return "0x" + bytesToHex(keccak_256(serialised));
}

export interface Intent {
  /** The address the caller asked to pay. */
  recipient: string;
  /** The amount the caller asked to pay, as a decimal string. */
  amount: string;
}

export interface Decoded {
  chain: string;
  token: string;
  recipient: string;
  amount: string;
  nonce: number;
}

function units(amount: string, decimals: number): bigint {
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals));
}

export class TransactionRejected extends Error {
  readonly checks: string[];
  constructor(message: string, checks: string[]) {
    super(message);
    this.name = "TransactionRejected";
    this.checks = checks;
  }
}

/*
  Decode and check the prepared transaction against the caller's intent, then
  recompute its hash. Throws TransactionRejected on the first disagreement,
  naming every check that failed.
*/
export function verifyTemplate(
  template: RailTemplate,
  claimedHash: string,
  intent: Intent
): Decoded {
  const failed: string[] = [];

  const rules = CHAINS[template.chainId];
  if (!rules) {
    throw new TransactionRejected(
      `The prepared transaction is for chain ${template.chainId}, which this SDK does not pay on.`,
      [`chain_id ${template.chainId} is not a known chain`]
    );
  }

  if (String(template.type) !== "eip1559") {
    failed.push(`transaction type is ${template.type}, expected eip1559`);
  }
  if (template.to.toLowerCase() !== rules.token) {
    failed.push(`token contract is ${template.to}, expected ${rules.token} on ${rules.name}`);
  }
  if (BigInt(template.value) !== 0n) {
    failed.push(`the transaction sends ${template.value} wei of native currency; a token transfer must send none`);
  }

  /* transfer(address,uint256): selector + 32-byte address + 32-byte amount. */
  const data = template.data.toLowerCase().replace(/^0x/, "");
  let decodedRecipient = "";
  let decodedUnits = 0n;
  if (data.length !== 136 || !data.startsWith(ERC20_TRANSFER)) {
    failed.push("the calldata is not a plain ERC-20 transfer");
  } else {
    const addrWord = data.slice(8, 72);
    if (!/^0{24}[0-9a-f]{40}$/.test(addrWord)) {
      failed.push("the transfer recipient is not a clean 20-byte address");
    }
    decodedRecipient = "0x" + addrWord.slice(24);
    decodedUnits = BigInt("0x" + data.slice(72));

    if (decodedRecipient !== intent.recipient.toLowerCase()) {
      failed.push(`the transaction pays ${decodedRecipient}, but you asked to pay ${intent.recipient.toLowerCase()}`);
    }
    const wanted = units(intent.amount, rules.decimals);
    if (decodedUnits !== wanted) {
      failed.push(`the transaction moves ${decodedUnits} base units, but you asked for ${wanted}`);
    }
  }

  const recomputed = templateHash(template);
  if (recomputed.toLowerCase() !== claimedHash.toLowerCase()) {
    failed.push(`the hash you were asked to sign (${claimedHash}) is not the hash of these bytes (${recomputed})`);
  }

  if (failed.length > 0) {
    throw new TransactionRejected(
      "The prepared transaction does not match the payment you asked for; nothing was signed.",
      failed
    );
  }

  return {
    chain: rules.name,
    token: template.to,
    recipient: decodedRecipient,
    amount: intent.amount,
    nonce: template.nonce,
  };
}

/*
  A replacement (fee bump) may raise fees and nothing else. Everything that
  decides where the money goes must be byte-identical to the transaction the
  agent already checked.
*/
export function verifyReplacement(previous: RailTemplate, next: RailTemplate): void {
  const failed: string[] = [];
  for (const field of ["chainId", "nonce", "to", "value", "data"] as const) {
    if (String(previous[field]).toLowerCase() !== String(next[field]).toLowerCase()) {
      failed.push(`${field} changed from ${previous[field]} to ${next[field]}`);
    }
  }
  if (BigInt(next.maxFeePerGas) < BigInt(previous.maxFeePerGas)) {
    failed.push("the replacement lowers maxFeePerGas; a bump must raise it");
  }
  if (failed.length > 0) {
    throw new TransactionRejected(
      "The replacement transaction changes more than its fees; nothing was signed.",
      failed
    );
  }
}
