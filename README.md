# The Cartulary Standard

Draft 0.1. A schema for payment receipts that prove themselves, published so
anyone can implement it without Cartulary.

A cartulary is a bound collection of charters and deeds. This standard treats
the record of an agent-initiated payment the same way: an append-only chain of
receipts, each one hashing its predecessor, verifiable by any party holding
the chain, and disclosable per leg on a need-to-know basis.

Status: draft, extracted from the running implementation at
[cartulary.xyz](https://cartulary.xyz). The console's Evidence screens and its
exported bundles conform to this document. Expect breaking changes until 1.0.

## The receipt

Every event in a payment's life is one receipt:

| Field | Type | Meaning |
|---|---|---|
| `payment_id` | string | The payment this receipt belongs to |
| `seq` | integer | Position in the chain, starting at 1, no gaps |
| `event_type` | string | `initiated`, `evaluated`, `screened`, `allowed`, `held`, `released`, `blocked`, `escalated`, `reported`, `settled`, or `refused` |
| `actor` | string | Who wrote it: `agent:<name>`, `operator:<session>`, or a system component |
| `payload` | object | Event detail; see payload rules below |
| `prev_hash` | string or null | The previous receipt's hash; null for `seq` 1 |
| `hash` | string | This receipt's hash; see construction below |
| `created_at` | timestamp | When the event happened |

Receipts are append only. A correction is a new receipt, never an edit.

## Hash construction

`hash` is the lowercase hex SHA-256 of the RFC 8785 (JCS) canonical JSON of:

```json
{
  "actor": "...",
  "env": "live | simulated",
  "event_type": "...",
  "payload": { },
  "payment_id": "...",
  "prev_hash": "... or null",
  "seq": 1
}
```

Two payload rules make canonicalisation exact by construction:

1. **Amounts are fixed-point strings** (`"2400000.000000"`, six decimal
   places), never JSON numbers. Money must survive canonicalisation without a
   float in sight.
2. **Numbers appearing in payloads are integers only** (sequence numbers,
   versions). Anything fractional travels as a string.

Verification is mechanical: recompute each hash from the row's own contents
and its predecessor's hash, and check that `seq` runs 1, 2, 3 … with no gaps.

**What verification proves, exactly.** A chain that verifies proves no
disclosed receipt was altered, reordered, or removed from the interior of
the chain. It cannot prove that the chain was not truncated at the tail, or
that a whole payment's chain was not omitted. Those guarantees require
anchoring chains to an organisation-level commitment, which is on the
Cartulary roadmap and will be added to this standard when it ships. A
standard that overstated its own proofs would fail its own test.

## Refusal semantics

A payment that violates its mandate or policy is refused before construction:
no value moves, and the *attempt* is receipted (`initiated` then `refused`,
with the rule that refused it in the payload). A control plane that cannot
show its refusals has never been tested by one.

## Disclosure

Disclosure is per leg. A counterparty receives the receipts for its own leg
(`initiated`, `settled`); internal receipts (`evaluated`, `screened`, hold
deliberations) are withheld, but their **hashes are not**. A party holding a
partially disclosed chain can still verify its integrity end to end, because
verification needs hashes and sequence, not payloads. Selective disclosure and
verifiability are not in tension; that is the point of the design.

## The evidence bundle

`examples/evidence-bundle.json` is a real bundle exported from the running
system: the payment summary, its full chain, and a verification block
recomputed at export time. Schema name: `cartulary/evidence-bundle/0.1`.

## Licence

Apache-2.0. Implement it, fork it, or tell us what is wrong with it:
issues are welcome.
