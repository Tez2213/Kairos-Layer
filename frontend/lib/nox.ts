"use client";

import { createViemHandleClient, type HandleClient } from "@iexec-nox/handle";
import type { WalletClient } from "viem";

/**
 * Nox handle client, memoised per connected account.
 *
 * The SDK ships Sepolia in its network table, so no config is needed — it
 * resolves the gateway, subgraph and NoxCompute address from the chain id.
 */
let cached: { key: string; client: HandleClient } | undefined;

export async function getHandleClient(walletClient: WalletClient): Promise<HandleClient> {
  const key = walletClient.account?.address ?? "none";
  if (cached?.key === key) return cached.client;
  const client = await createViemHandleClient(walletClient);
  cached = { key, client };
  return client;
}

export const ZERO_HANDLE = `0x${"0".repeat(64)}` as const;

/**
 * Decryption is only possible once the TEE has resolved the handle, which takes
 * tens of seconds on a live network. Retry rather than surfacing a raw failure.
 */
export async function decryptWithRetry(
  client: HandleClient,
  handle: `0x${string}`,
  { attempts = 30, delayMs = 4000 }: { attempts?: number; delayMs?: number } = {},
): Promise<bigint> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const { value } = await client.decrypt(handle);
      return value as bigint;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

export async function publicDecryptWithRetry(
  client: HandleClient,
  handle: `0x${string}`,
  { attempts = 45, delayMs = 4000 }: { attempts?: number; delayMs?: number } = {},
): Promise<{ value: bigint; decryptionProof: `0x${string}` }> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await client.publicDecrypt(handle);
      return { value: res.value as bigint, decryptionProof: res.decryptionProof as `0x${string}` };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
