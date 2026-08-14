# One payment on Canton, verified before it is signed, and four attempts to
# get a different payment signed instead.
#
# Run against the local network started from this folder:
#   python cartulary_demo.py --party "Treasury::1220…" --key private_key.der

import argparse
import copy
import json
import sys

import grpc
from com.daml.ledger.api.v2.interactive import (
    interactive_submission_service_pb2_grpc as iss_grpc,
)
from cryptography.hazmat.primitives import serialization

from cartulary_adapter import (
    ApprovedIntent,
    TransactionRejected,
    load_signer,
    prepare_payment,
    recompute_hash,
    sign_and_execute,
    verify_before_signing,
)

GREEN = "\033[32m"
RED = "\033[31m"
DIM = "\033[2m"
OFF = "\033[0m"


def ok(msg):
    print(f"  {GREEN}✓{OFF} {msg}")


def bad(msg):
    print(f"  {RED}✗{OFF} {msg}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--party", required=True, help="the external party acting as treasury")
    ap.add_argument("--recipient", required=True, help="the party being paid")
    ap.add_argument("--key", default="private_key.der")
    ap.add_argument("--fingerprint", required=True)
    ap.add_argument("--synchronizer", required=True)
    ap.add_argument("--port", default="4001")
    args = ap.parse_args()

    channel = grpc.insecure_channel(f"localhost:{args.port}")
    client = iss_grpc.InteractiveSubmissionServiceStub(channel)
    signer = load_signer(args.key)

    # What Cartulary decided, before anything was prepared. In the product
    # this comes from the mandate and the signed policy; here it is stated
    # plainly so the checks below have something to be checked against.
    intent = ApprovedIntent(
        payer=args.party,
        recipient=args.recipient,
        amount="125.0000000000",
        currency="USD",
        mandate="mandate-treasury-supplier-payments",
        policy_version=2,
        synchronizer_id=args.synchronizer,
    )

    failures = 0

    print("\n1. The participant prepares the payment")
    response = prepare_payment(client, intent)
    prepared = response.prepared_transaction
    print(f"     {DIM}nodes: {len(prepared.transaction.nodes)}, "
          f"hash offered: {response.prepared_transaction_hash.hex()[:20]}…{OFF}")
    ok("prepared")

    print("\n2. Cartulary reads it before signing anything")
    try:
        decoded, hash_to_sign = verify_before_signing(response, intent)
        ok(f"pays {decoded.amount} {decoded.currency} to {decoded.recipient.split('::')[0]}")
        ok(f"instrument is {decoded.template}")
        ok(f"one payment, no other actions ({decoded.node_count} node(s))")
        ok(f"hash recomputed here and matches: {hash_to_sign.hex()[:20]}…")
    except TransactionRejected as e:
        bad(str(e))
        for c in e.checks:
            print(f"      {c}")
        sys.exit(1)

    print("\n3. A participant that proposes a different payment is refused")

    # Each of these tampers with the prepared transaction and then recomputes
    # the hash so that the transaction is internally consistent, which is the
    # only interesting case: a mismatched hash is trivially caught, whereas a
    # consistent lie is caught only by comparing against the approval.
    def tamper(mutate, description):
        nonlocal failures
        evil = copy.deepcopy(response)
        mutate(evil.prepared_transaction)
        evil.prepared_transaction_hash = recompute_hash(evil.prepared_transaction, evil.hashing_scheme_version)
        try:
            verify_before_signing(evil, intent)
            bad(f"{description}: ACCEPTED")
            failures += 1
        except TransactionRejected as e:
            ok(f"{description}: refused, {e.checks[0]}")

    def set_field(tx, label, setter):
        for node in tx.transaction.nodes:
            if node.v1.HasField("create"):
                for f in node.v1.create.argument.record.fields:
                    if f.label == label:
                        setter(f.value)

    def redirect(tx):
        set_field(tx, "owner", lambda v: setattr(v, "party", intent.payer))

    def inflate(tx):
        for node in tx.transaction.nodes:
            if node.v1.HasField("create"):
                for f in node.v1.create.argument.record.fields:
                    if f.label == "amount":
                        for g in f.value.record.fields:
                            if g.label == "value":
                                g.value.numeric = "125000.0000000000"

    def switch_currency(tx):
        for node in tx.transaction.nodes:
            if node.v1.HasField("create"):
                for f in node.v1.create.argument.record.fields:
                    if f.label == "amount":
                        for g in f.value.record.fields:
                            if g.label == "currency":
                                g.value.text = "XXX"

    tamper(redirect, "recipient changed")
    tamper(inflate, "amount inflated a thousandfold")
    tamper(switch_currency, "currency switched")

    # And the trivial case, for completeness: bytes changed without bothering
    # to make the hash agree.
    evil = copy.deepcopy(response)
    set_field(evil.prepared_transaction, "owner", lambda v: setattr(v, "party", intent.payer))
    try:
        verify_before_signing(evil, intent)
        bad("hash left stale: ACCEPTED")
        failures += 1
    except TransactionRejected as e:
        hash_caught = any("not the hash of these bytes" in c for c in e.checks)
        ok(f"hash left stale: refused{' on the hash too' if hash_caught else ''}")

    print("\n4. The approved payment is signed and submitted")
    submission_id = sign_and_execute(
        client, response, intent, signer, args.fingerprint, hash_to_sign
    )
    ok(f"submitted as {submission_id}")

    print(f"\n{'All checks passed.' if failures == 0 else str(failures) + ' FAILED'}")
    print(json.dumps({
        "payer": intent.payer,
        "recipient": intent.recipient,
        "amount": intent.amount,
        "currency": intent.currency,
        "mandate": intent.mandate,
        "policy_version": intent.policy_version,
        "signing_hash": hash_to_sign.hex(),
        "submission_id": submission_id,
    }, indent=2))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
