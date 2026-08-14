# cartulary (SDK)

Pay under governance. Five lines that pay:

```js
import { Cartulary } from "cartulary";

const agent = new Cartulary({ apiKey: process.env.CARTULARY_KEY, agent: "procurement" });
const paid = await agent.pay({ to: "0x1F98431c8aD98523631AE4a59f267346ea31F984", amount: "1.50" });
console.log(paid.status, paid.txHash, paid.evidence);
```

Behind that call: Cartulary evaluates the payment against the agent's mandate and the organisation's signed policy, returns the unsigned transaction as a template, the SDK signs its hash with a key Cartulary never sees, the server verifies the signature recovers to the agent's bound wallet, relays it, and writes a hash-chained receipt for every step. `paid.evidence` is the payment's evidence page in the console: your organisation's members see it after signing in, and the exported bundle verifies with the dependency-free verifier in this repository. Simulated payments' evidence pages are public.

## What it does not do

- It holds no RPC endpoint, no gas logic, and no chain state; the server supplies everything except the signature.
- It cannot pay outside the mandate. A refusal throws a `RefusedError` naming the rule, and the refusal itself is receipted.
- It cannot rebind a wallet. Binding is write-once; a stolen API key cannot redirect funds to a new key. Rebinding is a governed console action.

## First run

The default signer generates a secp256k1 key at `./.cartulary/<agent>.key` (mode 600, gitignored), binds its address to the agent, and prints funding instructions once. Production agents should pass their own `signer` (two methods: `address()`, `sign(hash)`) backed by a KMS, an HSM, or an MPC service.

## Results and errors

`pay()` resolves to one of:

| status | meaning |
| --- | --- |
| `settled` | The settled receipt is written; `txHash`, `explorer`, and the full receipt chain are attached. |
| `submitted` | On chain, awaiting confirmation (`wait: false`); call `.wait()` to poll. |
| `held` | Above the escalation threshold; a human decides in the console. `.wait()` polls the outcome. |
| `simulated` | The sandbox settled it; no chain involved. |

Refusals throw `RefusedError`. Other named errors: `SettlementUnavailableError` (allowed, but nothing could move; the reason says why), `TemplateExpiredError`, `VerificationError`, `SettlementError`, `AuthError`, `RateLimitError`. Every error that has a remedy carries it as `.fix`.

## Idempotency

Every `pay()` carries an idempotency key (yours, or a generated one). A retried request replays the original decision, receipts and all, and can never create a second payment. Supply your own key when retries can cross process restarts:

```js
await agent.pay({ to, amount: "9.99", idempotencyKey: `invoice-2214` });
```

## When the chain misbehaves

Since 0.2.0 the unhappy paths heal themselves, and every recovery is receipted:

- **Expired template.** A template that dies unused (a paused process, a redeploy) is reissued for the same payment on the same idempotency key: fresh nonce and fees, recipient and amount immutable, receipted as a further `prepared` attempt. The SDK does this automatically on a 410.
- **Stuck transaction.** While waiting, the SDK asks for a fee bump if the transaction sits unmined past `bumpAfterMs` (default 60s). A bump is byte-identical except for its fees, same nonce, same calldata, so it can never move more money or move it elsewhere. Three bids, then a human looks. If the original mines first, the losing bid resolves as `superseded`, never as a false failure.
- **Reorganisation.** Settled is written at depth 2 and watched to depth 12. A block move appends a `reorg_observed` receipt to the chain; nothing is ever rewritten.

## Bring your own signer

Implement `Signer` (two methods: `address()`, `sign(hash)`) over a KMS, an HSM, or an MPC service, and prove it before trusting it:

```js
import { verifySigner } from "cartulary";
await verifySigner(mySigner); // throws unless signatures recover to address(), 65 bytes, low-s
```

A reference AWS KMS implementation lives at [`examples/aws-kms-signer.mjs`](../examples/aws-kms-signer.mjs).

## Sandbox

A `ck_test_…` key runs the same call against the simulated environment: real decisions, real receipt chains, no wallet and no chain. The published test key is `ck_test_bishopsgate`.

## Requirements

Node 18 or later. Two dependencies, both audited cryptography: `@noble/curves`, `@noble/hashes`. Settlement is on Base Sepolia (testnet USDC) today; the receipt chain and its verification are documented at [cartulary.xyz/standard](https://www.cartulary.xyz/standard).
