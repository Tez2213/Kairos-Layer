/**
 * Same-origin JSON-RPC proxy.
 *
 * Lets you point the app at a private endpoint (Alchemy, Infura, …) without
 * shipping the key to the browser: set SEPOLIA_RPC_URL as a *server-side*
 * environment variable and the key never leaves the server. With no env set it
 * forwards to a public endpoint, so the app works with zero configuration.
 *
 * Only read methods are forwarded — signing always happens in the user's wallet,
 * never here.
 */
import { NextResponse } from "next/server";

const UPSTREAM = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

const ALLOWED = new Set([
  "eth_call",
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBalance",
  "eth_getCode",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "net_version",
]);

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const calls = Array.isArray(body) ? body : [body];
  const blocked = calls.find(
    (c) => !ALLOWED.has((c as { method?: string })?.method ?? ""),
  ) as { method?: string } | undefined;
  if (blocked) {
    return NextResponse.json(
      { error: `method not allowed: ${blocked.method ?? "unknown"}` },
      { status: 403 },
    );
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "upstream RPC unreachable" }, { status: 502 });
  }
}
