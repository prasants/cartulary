#!/usr/bin/env node
// Verifies a Cartulary evidence bundle. No dependencies.
//
//   node verify.mjs examples/evidence-bundle.json
//
// Recomputes every receipt hash from the receipt's own fields, checks the
// prev_hash linkage and sequence continuity, and reports what was verified.
// A receipt whose payload is null is treated as withheld: it is verified by
// linkage only, which is exactly what a counterparty can do.
//
// What a passing result proves: no disclosed receipt was altered, reordered,
// or removed from the interior of the chain, relative to the hashes in this
// file. It does not prove authorship, and it cannot detect a chain truncated
// at the tail or omitted wholly. See README.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function canonicalise(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error("Non-integer number in canonical payload; amounts must be strings");
    }
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalise).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalise(value[k])).join(",") + "}";
}

function receiptHash(r) {
  const canonical = canonicalise({
    env: r.env,
    payment_id: r.payment_id,
    seq: r.seq,
    event_type: r.event_type,
    actor: r.actor,
    payload: r.payload,
    prev_hash: r.prev_hash,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

const path = process.argv[2];
if (!path) {
  console.error("Usage: node verify.mjs <bundle.json>");
  process.exit(2);
}

const bundle = JSON.parse(readFileSync(path, "utf8"));
const receipts = bundle.receipts ?? [];
let prev = null;
let prevSeq = 0;
let recomputed = 0;
let linkageOnly = 0;
const failures = [];

for (const r of receipts) {
  if (r.seq !== prevSeq + 1) failures.push(`seq ${r.seq}: sequence gap after ${prevSeq}`);
  if (r.prev_hash !== prev) failures.push(`seq ${r.seq}: prev_hash does not match preceding hash`);
  if (r.payload === null || r.payload === undefined) {
    linkageOnly++;
  } else {
    const h = receiptHash(r);
    if (h !== r.hash) failures.push(`seq ${r.seq}: recomputed hash ${h.slice(0, 12)}… does not match ${String(r.hash).slice(0, 12)}…`);
    else recomputed++;
  }
  prev = r.hash;
  prevSeq = r.seq;
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} problem(s) in ${receipts.length} receipts.`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}

console.log(
  `PASS: ${receipts.length} receipts in unbroken sequence; ` +
    `${recomputed} hash(es) recomputed correctly` +
    (linkageOnly > 0 ? `; ${linkageOnly} withheld receipt(s) verified by linkage only` : "") +
    `.`
);
console.log(
  "Proven: no disclosed receipt altered, reordered, or removed from the interior of this chain."
);
console.log(
  "Not proven: authorship, tail truncation, or whole-chain omission. See README."
);
