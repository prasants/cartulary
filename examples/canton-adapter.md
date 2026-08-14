# Binding a decision to a Canton transaction

The reasoning behind the adapter described in the standard, written against
a local network so that nobody has to grant anything to try it. The adapter
itself has been implemented and run: the code and its recorded run are in
[`canton/`](../canton/). What has not happened is a run on a shared network.
This is Canton's example Iou model, so it is a payment in shape and not a
stablecoin settlement, and it is not integrated into the hosted application
at cartulary.xyz.

## Why the shape differs from an EVM rail

On the EVM rail, Cartulary can prepare the entire transaction, because the
bytes that move the money are the bytes that get signed. A ledger that
prepares transactions on the participant side inverts this: the participant
prepares, and returns a hash for external signing. The signature therefore
commits to the prepared transaction and to nothing else. It does not commit
to the mandate that authorised the payment, the policy version in force, or
the screening result.

That is the whole design problem, and it is why the division of proof below
exists. An adapter that ignores it can prove a transaction was signed; it
cannot prove the transaction was the one that was approved.

## The two gates

**Gate one, before preparation.** The agent asks Cartulary whether the
payment may be attempted. Cartulary evaluates the mandate, the policy in
force, and screening, and answers allow, hold, or refuse. A refusal ends
here and is receipted; nothing is prepared. This gate is identical on every
rail, because it is about authority rather than mechanics.

**Gate two, after preparation and before signature.** The participant
prepares the transaction and returns its hash. Before that hash is signed,
the adapter must establish that the prepared transaction is the payment that
was approved:

1. Fetch the prepared transaction, not only its hash.
2. Decode it: sender, receiver, instrument, and amount.
3. Compare each against the approved decision, by identifier and not by
   label. A name is not an identity.
4. Recompute the hash from the decoded transaction and compare it with the
   hash the participant returned. A hash that does not follow from the bytes
   is refused, whatever it claims.
5. Sign only if every check passes. A failure is receipted as
   `verification_failed` with the differences named, and the payment stops.

The EVM implementation of exactly these steps is in
[`sdk/src/transaction.ts`](../sdk/src/transaction.ts), and its adversarial
tests are in [`sdk/test/behaviour.test.mjs`](../sdk/test/behaviour.test.mjs).
An adapter for another ledger differs in how it decodes and how it
recomputes; the obligation is the same.

## The division of proof

Neither system can prove the whole story alone, and pretending otherwise is
the failure mode to avoid.

| Fact | Proved by | Not proved by |
| --- | --- | --- |
| The payment was authorised by a mandate, under a policy version, with a screening result | The Cartulary receipt chain | The ledger, which never sees a mandate |
| The approved intent matches the transaction that was signed | The gate-two comparison, receipted | Either system in isolation |
| The transaction was committed, and its effects | The ledger's update identifier | Cartulary, which is not a validator |
| The evidence was not altered after the fact | Recomputation of the hash chain, and anchoring once it exists | The ledger, which stores no receipts |

The binding between the two halves is the `prepared` receipt: it carries the
transaction identifier and the recomputed hash, so an examiner holding the
chain can ask the ledger about that identifier and get an answer that either
agrees or does not.

## The receipt a Canton payment would carry

The chain is the same as any other; only the `prepared` and `settled`
payloads change. Every field below is hashed, as the standard requires.

```json
{
  "seq": 5,
  "event_type": "prepared",
  "actor": "cartulary:rail",
  "payload": {
    "ledger": "canton",
    "domain": "local-devnet",
    "prepared_transaction_hash": "0x…",
    "recomputed_hash": "0x…",
    "checks": [
      "sender matches the agent's registered party",
      "receiver matches the approved counterparty party identifier",
      "instrument matches the approved holding",
      "amount matches to the asset's scale"
    ],
    "mandate": "…",
    "policy_version": 2
  }
}
```

```json
{
  "seq": 8,
  "event_type": "settled",
  "actor": "cartulary:rail",
  "payload": {
    "ledger": "canton",
    "update_id": "…",
    "record_time": "2026-08-14T09:00:00.000Z"
  }
}
```

## What would make this real

A local participant to prepare against, a party for the agent and one for
the counterparty, and a holding to move. Then the same acceptance test the
EVM rail has: pay, refuse a payment that violates its mandate, tamper with
the prepared transaction and confirm the adapter refuses to sign it, and
recompute the resulting chain with `verify.mjs`. Until that test passes and
its output is published, the roadmap keeps this under Next rather than
Built.
