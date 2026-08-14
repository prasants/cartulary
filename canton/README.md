# The Canton adapter

Gate two, implemented against a Canton participant and run. This is an
external-signing and transaction-validation experiment on a local network,
not a stablecoin integration.

Canton prepares transactions on the participant side and returns a hash for
an external party to sign. The signature commits to the prepared transaction
and to nothing else: not to the mandate that authorised the payment, not to
the policy version in force, and not to the screening result. So whatever
the approval knew and the transaction does not carry has to be checked
before signing, or it is not checked at all.

Canton's own external signing example marks the spot. It ends with a
function that prints the prepared transaction under a comment saying this is
the application's chance to validate the ledger changes before signing. This
is that validation, written down and executed.

## What it does

Before the key is used, [`cartulary_adapter.py`](cartulary_adapter.py):

- decodes the prepared transaction rather than reading only its hash;
- requires exactly one create node, so no further action can be smuggled in
  beside the payment;
- checks the template against an identifier compiled into the adapter, not
  one supplied with the transaction;
- compares payer, recipient, amount, and currency against the approved
  intent, by identifier rather than by label;
- checks the transaction settles on the approved synchronizer;
- recomputes the signing hash from the transaction's own contents using the
  published hashing scheme, and compares it with the hash the participant
  offered;
- refuses on any disagreement, naming every one of them, and signs only if
  all of it agrees.

## Recorded run

Against a local Canton 3.5.13 network, one external party holding its own
ed25519 key, paying an Iou to a supplier party:

```
1. The participant prepares the payment
     nodes: 1, hash offered: 61d4c01b864fa78592b1…
  ✓ prepared

2. Cartulary reads it before signing anything
  ✓ pays 125.0000000000 USD to NorthgateSupplies
  ✓ instrument is 764252f6…:Iou:Iou
  ✓ one payment, no other actions (1 node(s))
  ✓ hash recomputed here and matches: 61d4c01b864fa78592b1…

3. A participant that proposes a different payment is refused
  ✓ recipient changed: refused, it pays BishopsgateTreasury::1220e2c3…,
    but the approval named NorthgateSupplies::122041ca…
  ✓ amount inflated a thousandfold: refused, it moves 125000.0000000000,
    but 125.0000000000 was approved
  ✓ currency switched: refused, it moves XXX, not the approved USD
  ✓ hash left stale: refused on the hash too

4. The approved payment is signed and submitted
  ✓ submitted as 2b7867f6-457c-437c-b9ac-da1ce91986c7

All checks passed.
```

The contract then appears in the active contract set of both parties.

What that establishes, precisely: a transaction was prepared by a
participant, decoded, compared against an approval held outside the ledger,
refused in three altered forms, signed by a key the ledger recognises, and
committed, with the resulting contract disclosed to exactly the parties
entitled to see it.

What it does not establish: the settlement of a stablecoin payment. The Iou
is Canton's own example template. It is a payment in shape, carrying parties,
an amount, and a currency, and it is not an issued stablecoin. Nothing here
demonstrates minting, burning, freezing, reserve backing, redemption rights,
final legal title to money, or atomic composition with another asset. Those
are the things that would make it a payment rather than a contract that looks
like one, and none of them are in scope for this experiment.

The three tampering cases in step 3 recompute the hash after altering the
transaction, so each one is internally consistent. That is the case worth
testing. A stale hash is caught by arithmetic; a consistent lie is caught
only by comparing the transaction with the approval, which is the whole
argument for doing this at all.

## Reproducing it

You need a JDK 21 and the Canton open-source release. From the release's
`examples/08-interactive-submission` folder:

```bash
# 1. Generate the Python bindings and start a local network
bash setup.sh
canton daemon -c interactive-submission.conf --bootstrap bootstrap.canton

# 2. Onboard an external party that holds its own key
bash external_party_onboarding.sh -n BishopsgateTreasury

# 3. Upload the example models and allocate a counterparty
curl -X POST localhost:7373/v2/packages \
  -H "Content-Type: application/octet-stream" \
  --data-binary @../../dars/CantonExamples.dar
curl -X POST localhost:7373/v2/parties -H "Content-Type: application/json" \
  -d '{"partyIdHint":"NorthgateSupplies","identityProviderId":""}'

# 4. Run the adapter
python cartulary_demo.py --party "BishopsgateTreasury::…" \
  --recipient "NorthgateSupplies::…" --fingerprint "…" \
  --synchronizer "$(cat synchronizer_id)" --key private_key.der
```

Two notes for release 3.5.13, both in `setup.sh` rather than in anything
here: the protobuf directory is `ledger-api` where the script expects
`ledger-api-proto`, and `ledger-api-value` where it expects
`ledger-api-value-proto`. On macOS, `base64 -w 0` in the onboarding script
should be `base64`.

## What this is not

It runs against a local network, so it demonstrates the mechanism and not
throughput, operations, or anything about a shared environment. The
instrument is the Iou template from Canton's own examples, which is a
payment in shape but is not a stablecoin issuer's model. Nothing here has
been run against DevNet or TestNet, which needs a participant willing to
sponsor access.

The equivalent for an EVM chain, with the same obligation and the same
adversarial tests, is in [`sdk/src/transaction.ts`](../sdk/src/transaction.ts).
The two differ in how they decode and how they recompute. What they refuse
to do without checking is the same.
