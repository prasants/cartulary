# Cartulary: the Canton adapter.
#
# Canton's own external signing example ends with a function that prints the
# prepared transaction and a comment saying this is the point at which an
# application should satisfy itself about what it is signing. This is that
# check, written down.
#
# The obligation, as the standard states it: fetch the prepared transaction
# rather than only its hash, decode it, compare every field that decides
# where money goes against the intent that was approved, recompute the hash
# from those bytes, and sign only if all of it agrees. A signature commits
# to the prepared transaction and to nothing else, so anything the approval
# knew and the transaction does not carry has to be checked here or it is
# not checked at all.

import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Optional

import grpc
from com.daml.ledger.api.v2 import commands_pb2, crypto_pb2, value_pb2
from com.daml.ledger.api.v2.interactive import (
    interactive_submission_service_pb2 as iss_pb2,
)
from com.daml.ledger.api.v2.interactive import (
    interactive_submission_service_pb2_grpc as iss_grpc,
)
from cryptography.hazmat.primitives import serialization
from daml_transaction_hashing_common import create_nodes_dict
import daml_transaction_hashing_v2
import daml_transaction_hashing_v3

USER_ID = "cartulary"

# The instrument this adapter will pay through, pinned here rather than read
# from whatever the server proposes. Checking server-supplied bytes against
# server-supplied expectations proves nothing.
IOU_TEMPLATE = value_pb2.Identifier(
    package_id="764252f6c2236376a83c134318e7856e046ff469481b28dcdc84372fa636d91a",
    module_name="Iou",
    entity_name="Iou",
)


class TransactionRejected(Exception):
    """The prepared transaction is not the payment that was approved."""

    def __init__(self, message: str, checks: list[str]):
        super().__init__(message)
        self.checks = checks


@dataclass
class ApprovedIntent:
    """What Cartulary decided may happen, before anything was prepared."""

    payer: str
    recipient: str
    amount: str
    currency: str
    mandate: str
    policy_version: int
    synchronizer_id: str


@dataclass
class Decoded:
    """What the prepared transaction actually does, in plain terms."""

    template: str
    payer: str
    recipient: str
    amount: str
    currency: str
    node_count: int


def prepare_payment(client, intent: ApprovedIntent) -> iss_pb2.PrepareSubmissionResponse:
    """Ask the participant to prepare the payment. It proposes; we verify."""
    command = commands_pb2.Command(
        create=commands_pb2.CreateCommand(
            template_id=IOU_TEMPLATE,
            create_arguments=value_pb2.Record(
                fields=[
                    value_pb2.RecordField(label="payer", value=value_pb2.Value(party=intent.payer)),
                    value_pb2.RecordField(label="owner", value=value_pb2.Value(party=intent.recipient)),
                    value_pb2.RecordField(
                        label="amount",
                        value=value_pb2.Value(
                            record=value_pb2.Record(
                                fields=[
                                    value_pb2.RecordField(
                                        label="value", value=value_pb2.Value(numeric=intent.amount)
                                    ),
                                    value_pb2.RecordField(
                                        label="currency", value=value_pb2.Value(text=intent.currency)
                                    ),
                                ]
                            )
                        ),
                    ),
                    value_pb2.RecordField(
                        label="viewers",
                        value=value_pb2.Value(list=value_pb2.List(elements=[])),
                    ),
                ]
            ),
        )
    )
    request = iss_pb2.PrepareSubmissionRequest(
        user_id=USER_ID,
        command_id=str(uuid.uuid4()),
        act_as=[intent.payer],
        read_as=[intent.payer],
        synchronizer_id=intent.synchronizer_id,
        commands=[command],
    )
    return client.PrepareSubmission(request)


def _field(record, label: str):
    for f in record.fields:
        if f.label == label:
            return f.value
    return None


def decode(prepared: iss_pb2.PreparedTransaction) -> Decoded:
    """Read the payment out of the prepared transaction."""
    nodes = list(prepared.transaction.nodes)
    creates = []
    for node in nodes:
        v1 = node.v1
        if v1.HasField("create"):
            creates.append(v1.create)

    if len(creates) != 1:
        raise TransactionRejected(
            "The prepared transaction does not contain exactly one payment.",
            [f"expected 1 create node, found {len(creates)} in {len(nodes)} nodes"],
        )

    create = creates[0]
    if not create.HasField("argument") or not create.argument.HasField("record"):
        raise TransactionRejected(
            "The prepared transaction carries no arguments to inspect.", ["the create node has no record argument"]
        )
    args = create.argument.record

    amount = _field(args, "amount")
    amount_record = amount.record if amount is not None and amount.HasField("record") else None
    return Decoded(
        template=f"{create.template_id.package_id[:8]}…:{create.template_id.module_name}:{create.template_id.entity_name}",
        payer=(_field(args, "payer").party if _field(args, "payer") else ""),
        recipient=(_field(args, "owner").party if _field(args, "owner") else ""),
        amount=(_field(amount_record, "value").numeric if amount_record else ""),
        currency=(_field(amount_record, "currency").text if amount_record else ""),
        node_count=len(nodes),
    )


def recompute_hash(
    prepared: iss_pb2.PreparedTransaction,
    scheme=iss_pb2.HashingSchemeVersion.HASHING_SCHEME_VERSION_V2,
) -> bytes:
    """
    Recompute the signing hash from the transaction's own contents, using the
    published scheme the participant declared. The hash it returned alongside
    is never taken on trust; it is compared with this one.
    """
    if scheme == iss_pb2.HashingSchemeVersion.HASHING_SCHEME_VERSION_V3:
        encode = daml_transaction_hashing_v3.encode_prepared_transaction
    else:
        encode = daml_transaction_hashing_v2.encode_prepared_transaction
    return encode(prepared, create_nodes_dict(prepared))


def verify_before_signing(
    response: iss_pb2.PrepareSubmissionResponse, intent: ApprovedIntent
) -> tuple[Decoded, bytes]:
    """
    Gate two. Returns the decoded payment and the hash to sign, or refuses
    with every disagreement named. Nothing is signed before this passes.
    """
    prepared = response.prepared_transaction
    failed: list[str] = []

    decoded = decode(prepared)

    if not decoded.template.endswith(f":{IOU_TEMPLATE.module_name}:{IOU_TEMPLATE.entity_name}"):
        failed.append(f"the transaction creates {decoded.template}, which is not the approved instrument")
    if not decoded.template.startswith(IOU_TEMPLATE.package_id[:8]):
        failed.append("the transaction uses a package this adapter does not pay through")
    if decoded.payer != intent.payer:
        failed.append(f"it pays from {decoded.payer}, not {intent.payer}")
    if decoded.recipient != intent.recipient:
        failed.append(f"it pays {decoded.recipient}, but the approval named {intent.recipient}")
    if decoded.currency != intent.currency:
        failed.append(f"it moves {decoded.currency}, not the approved {intent.currency}")
    if Decimal(decoded.amount or "0") != Decimal(intent.amount):
        failed.append(f"it moves {decoded.amount}, but {intent.amount} was approved")

    if not prepared.metadata.synchronizer_id.startswith(intent.synchronizer_id):
        failed.append(
            f"it settles on {prepared.metadata.synchronizer_id}, not the approved {intent.synchronizer_id}"
        )

    recomputed = recompute_hash(prepared, response.hashing_scheme_version)
    returned = response.prepared_transaction_hash
    if recomputed != returned:
        failed.append(
            f"the hash offered for signature ({returned.hex()[:16]}…) is not the hash of these bytes ({recomputed.hex()[:16]}…)"
        )

    if failed:
        raise TransactionRejected(
            "The prepared transaction is not the payment that was approved; nothing was signed.",
            failed,
        )

    return decoded, recomputed


def sign_and_execute(
    client,
    response: iss_pb2.PrepareSubmissionResponse,
    intent: ApprovedIntent,
    private_key,
    fingerprint: str,
    hash_to_sign: bytes,
) -> str:
    """Sign the verified hash and submit. The key never leaves this process."""
    signature = private_key.sign(hash_to_sign)
    submission_id = str(uuid.uuid4())
    request = iss_pb2.ExecuteSubmissionRequest(
        prepared_transaction=response.prepared_transaction,
        hashing_scheme_version=response.hashing_scheme_version,
        party_signatures=iss_pb2.PartySignatures(
            signatures=[
                iss_pb2.SinglePartySignatures(
                    party=intent.payer,
                    signatures=[
                        crypto_pb2.Signature(
                            format=crypto_pb2.SignatureFormat.SIGNATURE_FORMAT_CONCAT,
                            signature=signature,
                            signed_by=fingerprint,
                            signing_algorithm_spec=crypto_pb2.SigningAlgorithmSpec.SIGNING_ALGORITHM_SPEC_ED25519,
                        )
                    ],
                )
            ]
        ),
        submission_id=submission_id,
        user_id=USER_ID,
    )
    client.ExecuteSubmission(request)
    return submission_id


def load_signer(private_key_file: str):
    with open(private_key_file, "rb") as f:
        return serialization.load_der_private_key(f.read(), password=None)
