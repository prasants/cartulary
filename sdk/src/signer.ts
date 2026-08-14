import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils";
import { mkdirSync, readFileSync, writeFileSync, statSync, existsSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

/*
  The signer owns the agent's key; Cartulary never sees it. The default is a
  local file at ./.cartulary/<agent>.key, created on first run at mode 0600
  with a .gitignore beside it. Production agents should implement Signer over
  a KMS, an HSM, or an MPC service instead: the interface is two methods.
*/

export interface Signer {
  /** The EVM address this signer controls, EIP-55 checksummed. */
  address(): Promise<string>;
  /** Sign a 32-byte hash; return 65 bytes hex: r (32) + s (32) + recovery (1). */
  sign(hash: `0x${string}`): Promise<`0x${string}`>;
}

export function checksumAddress(addr: string): string {
  const hex = addr.toLowerCase().replace(/^0x/, "");
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(hex)));
  let out = "0x";
  for (let i = 0; i < hex.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  }
  return out;
}

function addressOf(privateKey: Uint8Array): string {
  const pub = secp256k1.getPublicKey(privateKey, false);
  const addr = bytesToHex(keccak_256(pub.slice(1)).slice(-20));
  return checksumAddress("0x" + addr);
}

export class FileSigner implements Signer {
  private readonly key: Uint8Array;
  readonly path: string;
  readonly generated: boolean;

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      const mode = statSync(path).mode & 0o777;
      if (mode & 0o077) {
        process.emitWarning(
          `Key file ${path} is readable by others (mode ${mode.toString(8)}); chmod 600 is safer.`
        );
      }
      const hex = readFileSync(path, "utf8").trim().replace(/^0x/, "");
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(`Key file ${path} must hold a 32-byte hex private key.`);
      }
      this.key = hexToBytes(hex);
      this.generated = false;
    } else {
      this.key = randomBytes(32);
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const gitignore = join(dir, ".gitignore");
      if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n", { mode: 0o600 });
      writeFileSync(path, "0x" + bytesToHex(this.key) + "\n", { mode: 0o600 });
      chmodSync(path, 0o600);
      this.generated = true;
    }
  }

  async address(): Promise<string> {
    return addressOf(this.key);
  }

  async sign(hash: `0x${string}`): Promise<`0x${string}`> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new Error("sign() expects a 32-byte 0x… hash.");
    }
    const sig = secp256k1.sign(hexToBytes(hash.slice(2)), this.key, { lowS: true });
    const compact = bytesToHex(sig.toCompactRawBytes());
    const v = sig.recovery.toString(16).padStart(2, "0");
    return ("0x" + compact + v) as `0x${string}`;
  }
}
