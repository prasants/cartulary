/* The whole loop: decide, sign, submit, settle, receipted at every step.
   Run: CARTULARY_KEY=ck_live_… node examples/pay.mjs */
import { Cartulary, RefusedError } from "cartulary";

const agent = new Cartulary({ apiKey: process.env.CARTULARY_KEY, agent: "procurement" });

try {
  const paid = await agent.pay({ to: "0x000000000000000000000000000000000000dEaD", amount: "0.50" });
  console.log(paid.status, paid.txHash);
  console.log("evidence:", paid.evidence);
} catch (err) {
  if (err instanceof RefusedError) {
    console.error("refused:", err.reasons[0]);
    console.error("receipted at:", err.evidence);
  } else throw err;
}
