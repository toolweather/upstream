// MCP paid tool call on Base Sepolia TESTNET (payer key from /workspace/.secrets/upstream_testnet_payer_key)
import { readFileSync } from "node:fs";
import { x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
const pk = readFileSync("/workspace/.secrets/upstream_testnet_payer_key", "utf8").match(/PRIVATE_KEY=(0x[0-9a-f]+)/i)[1];
const client = new x402Client().register("eip155:84532", new ExactEvmScheme(privateKeyToAccount(pk)));
const U = (process.env.U || "https://upstream.toolweather.workers.dev") + "/mcp";
const H = { "content-type": "application/json", ...(process.env.K ? { "x-api-key": process.env.K } : {}) };
const call = (params) => fetch(U, { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }) }).then((r) => r.json());
const p = { name: "get_model", arguments: { id: process.argv[2] || "claude-3-opus-20240229" } };
const a = await call(p);
const req = a.result?._meta?.["x402/payment-required"];
if (!req) { console.log("no payment required (free quota?)", JSON.stringify(a).slice(0, 200)); process.exit(0); }
console.log("got requirement:", req.accepts[0].amount, req.accepts[0].network);
const payload = await client.createPaymentPayload(req);
const b = await call({ ...p, _meta: { "x402/payment": payload } });
console.log("isError", b.result?.isError, "payment-response", JSON.stringify(b.result?._meta?.["x402/payment-response"]));
console.log(b.result?.content?.[0]?.text?.slice(0, 200));
