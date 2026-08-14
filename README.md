# The Cartulary Standard

Draft 0.1. A portable receipt chain for agent-initiated payments that detects
modification relative to a trusted receipt hash or external anchor. Published
so anyone can implement and verify it without Cartulary.

A cartulary is a bound collection of charters and deeds. This standard treats
the record of a payment the same way: an append-only chain of receipts, each
one hashing its predecessor, verifiable by recomputation, and disclosable per
leg on a need-to-know basis.

Status: draft, extracted from the running implementation at
[cartulary.xyz](https://cartulary.xyz). The console's Evidence screens and its
exported bundles conform to this document, and the example bundle in this
repository verifies with the verifier in this repository. Expect breaking
changes until 1.0.

## The SDK

[`sdk/`](sdk/) holds `cartulary`, the TypeScript SDK that produces these
receipt chains from the paying side: one call decides a payment against the
agent's mandate and its organisation's signed policy, signs the issued
template with a key Cartulary never sees, and waits for the settled receipt.
Two dependencies, no RPC. Its README documents the result and error model;
[`examples/pay.mjs`](examples/pay.mjs) is a runnable example.

## Verify the example yourself

```
node verify.mjs examples/evidence-bundle.json
```

No dependencies. The verifier recomputes every hash from each receipt's own
fields and checks linkage and sequence. Three adversarial vectors ship beside
the example and run in CI on every change:

- `tampered-bundle.json`: one payload field altered; verification fails.
- `truncated-bundle.json`: the tail dropped; verification passes, which is
  the documented boundary, not a bug (see below).
- `partially-disclosed-bundle.json`: internal payloads withheld; disclosed
  receipts verify by recomputation, withheld ones by linkage alone.

## The receipt

Every event in a payment's life is one receipt:

| Field | Type | Meaning |
|---|---|---|
| `payment_id` | string | The payment's identifier: the bundle's `payment.id`. Present on every receipt so each is verifiable alone |
| `env` | string | `live`, `simulated`, or `testnet`. Present on every receipt |
| `seq` | integer | Position in the chain, starting at 1, no gaps |
| `event_type` | string | `initiated`, `evaluated`, `screened`, `allowed`, `held`, `investigating`, `released`, `blocked`, `escalated`, `reported`, `settled`, or `refused` |
| `actor` | string | Who wrote it: `agent:<name>`, `operator:<session>`, or a system component |
| `payload` | object or null | Event detail; `null` when withheld under disclosure |
| `prev_hash` | string or null | The previous receipt's hash; null for `seq` 1 |
| `hash` | string | This receipt's hash; see construction below |
| `created_at` | timestamp | When the event happened; not part of the hash |

Receipts are append only. A correction is a new receipt, never an edit.

## Hash construction

`hash` is the lowercase hex SHA-256 of the RFC 8785 (JCS) canonical JSON of
exactly these seven fields:

```json
{
  "actor": "...",
  "env": "...",
  "event_type": "...",
  "payload": { },
  "payment_id": "...",
  "prev_hash": "... or null",
  "seq": 1
}
```

Two payload rules make canonicalisation exact by construction:

1. **Amounts are decimal strings**, never JSON numbers. The scale is set by
   the asset (this implementation uses six decimal places for its
   instruments); the rule is the string, not the scale.
2. **Numbers appearing in payloads are integers only** (sequence numbers,
   versions). Anything fractional travels as a string.

## What verification proves, exactly

Recomputing every hash and checking linkage and sequence proves that **no
disclosed receipt was altered, reordered, or removed from the interior of
the chain, relative to the hashes in hand**. Three limitations are part of
the design and are stated rather than hidden:

1. **Self-consistency is not authorship.** A hash chain has no signature. A
   party holding the whole chain could rewrite an event and recompute every
   subsequent hash, and the result would still verify. Detection of that
   requires a trusted chain head, a signature over the head, or an external
   anchor; anchoring is on the Cartulary roadmap and will be added to this
   standard when it ships.
2. **Truncation and omission are invisible to recomputation.** A chain cut
   at the tail, or a whole payment's chain withheld, verifies or simply does
   not appear. The same anchoring closes this.
3. **Partial disclosure verifies less, and says so.** A counterparty
   receives its own receipts and every hash. Disclosed receipts verify by
   recomputation; withheld receipts are opaque commitments verified by
   linkage alone. Their contents are not proven to the recipient, and the
   verifier reports the difference.

A standard that overstated its own proofs would fail its own test.

## Refusal semantics

A payment that violates its mandate or policy is refused before construction:
no value moves, and the attempt is receipted (`initiated` then `refused`,
with the rule that refused it in the payload). A control plane that cannot
show its refusals has never been tested by one.

## The evidence bundle

`examples/evidence-bundle.json` is a real bundle exported from the running
system: the payment summary, its full chain with every hashed field on every
receipt, and a verification block recomputed at export time. Schema name:
`cartulary/evidence-bundle/0.1`.

## Binding a decision to a ledger transaction

[`examples/canton-adapter.md`](examples/canton-adapter.md) works through the
adapter for a ledger that prepares transactions on the participant side and
returns a hash for external signing: the two gates, what each half of the
system can and cannot prove, and the receipts a Canton payment would carry.
It is a specification with worked payloads, written against a local network
so that nobody has to grant access to try it. Nothing in it has been run
against a shared network, and it is marked Next rather than Built for that
reason.

The EVM implementation of the same gate-two obligation is real and tested:
[`sdk/src/transaction.ts`](sdk/src/transaction.ts) decodes the prepared
transaction, checks it against the approved intent, and recomputes its hash
before signing.

## Planned for later drafts

Machine-readable JSON Schemas for receipts, bundles, and per-event payloads;
organisation-level anchoring; and the Canton adapter above, executed rather
than specified.

## Licence

Apache-2.0; see [LICENSE](LICENSE). Implement it, fork it, or tell us what is
wrong with it: issues are welcome, and corrections are made in public.
