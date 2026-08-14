/*
  Reference Signer over AWS KMS, for production agents that must not hold a
  key on disk. The key never leaves KMS; only signatures do.

  This is a reference: run verifySigner against it in your own account
  before trusting it with a payment. That check is the point of the
  conformance helper, and no reference implementation substitutes for it.

  Requires: an asymmetric KMS key with KeySpec ECC_SECG_P256K1 and
  KeyUsage SIGN_VERIFY, plus `npm install @aws-sdk/client-kms`.

  Run: KMS_KEY_ID=arn:aws:kms:… node examples/aws-kms-signer.mjs
*/
import { KMSClient, GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { verifySigner, checksumAddress } from "cartulary";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

export class KmsSigner {
  constructor(keyId, client = new KMSClient({})) {
    this.keyId = keyId;
    this.client = client;
    this.cachedAddress = null;
  }

  async address() {
    if (this.cachedAddress) return this.cachedAddress;
    const { PublicKey } = await this.client.send(
      new GetPublicKeyCommand({ KeyId: this.keyId })
    );
    /* KMS returns SPKI DER; the uncompressed point is its last 65 bytes. */
    const spki = new Uint8Array(PublicKey);
    const point = spki.slice(spki.length - 65);
    if (point[0] !== 0x04) throw new Error("Expected an uncompressed SECG P-256K1 public key.");
    this.cachedAddress = checksumAddress("0x" + bytesToHex(keccak_256(point.slice(1)).slice(-20)));
    return this.cachedAddress;
  }

  async sign(hash) {
    const digest = hexToBytes(hash.slice(2));
    const { Signature } = await this.client.send(
      new SignCommand({
        KeyId: this.keyId,
        Message: digest,
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      })
    );
    /* KMS signatures are DER and may carry a high s; normalise to low-s,
       then find the recovery bit by recovering and comparing. */
    let sig = secp256k1.Signature.fromDER(new Uint8Array(Signature));
    if (sig.hasHighS()) sig = sig.normalizeS();
    const expected = (await this.address()).toLowerCase();
    for (const recovery of [0, 1]) {
      const candidate = sig.addRecoveryBit(recovery);
      const pub = candidate.recoverPublicKey(digest).toRawBytes(false);
      const addr = "0x" + bytesToHex(keccak_256(pub.slice(1)).slice(-20));
      if (addr === expected) {
        return ("0x" +
          bytesToHex(candidate.toCompactRawBytes()) +
          recovery.toString(16).padStart(2, "0"));
      }
    }
    throw new Error("Neither recovery bit reproduces the KMS public key.");
  }
}

if (process.env.KMS_KEY_ID) {
  const signer = new KmsSigner(process.env.KMS_KEY_ID);
  const { address } = await verifySigner(signer);
  console.log(`KMS signer conforms; it signs for ${address}.`);
  console.log("Use it: new Cartulary({ apiKey, agent, signer })");
}
