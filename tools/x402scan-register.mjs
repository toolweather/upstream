// Register Upstream's paid resources on x402scan (SIWX = wallet signature only, no payment, no signup).
// Signs with the Upstream receiving key so the listing is tied to the pay-to address.
import { readFileSync } from "node:fs";
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import { privateKeyToAccount } from "viem/accounts";
const pk = readFileSync("/workspace/.secrets/upstream_testnet_key", "utf8").match(/PRIVATE_KEY=(0x[0-9a-f]+)/i)[1];
const acct = privateKeyToAccount(pk);
const url = process.argv[2] || "https://www.x402scan.com/api/x402/registry/register-origin";
const body = JSON.stringify({ origin: "https://upstream.toolweather.workers.dev" });
const H = { "content-type": "application/json" };
const ch = await (await fetch(url, { method: "POST", headers: H, body })).json();
const ext = ch.extensions["sign-in-with-x"];
const payload = await createSIWxPayload({ ...ext.info, chainId: ext.supportedChains[0].chainId, type: ext.supportedChains[0].type }, acct, url);
const r = await fetch(url, { method: "POST", headers: { ...H, "SIGN-IN-WITH-X": encodeSIWxHeader(payload) }, body });
console.log(r.status); console.log((await r.text()).slice(0, 3000));
