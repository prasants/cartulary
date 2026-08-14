# @cartulary/agent

Pay under governance. Five lines that pay:

```js
import { Cartulary } from "@cartulary/agent";

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

## Sandbox

A `ck_test_…` key runs the same call against the simulated environment: real decisions, real receipt chains, no wallet and no chain. The published test key is `ck_test_bishopsgate`.

## Requirements

Node 18 or later. Two dependencies, both audited cryptography: `@noble/curves`, `@noble/hashes`. Settlement is on Base Sepolia (testnet USDC) today; the receipt chain and its verification are documented at [cartulary.xyz/standard](https://www.cartulary.xyz/standard).
