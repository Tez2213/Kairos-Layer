"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { A, publicClient } from "./chain";
import { CTOKEN_ABI, ERC20_ABI, KAIROS_POOL_ABI } from "./generated";

export type Epoch = {
  state: number;
  residual: number;
  startTime: bigint;
  endTime: bigint;
  sealedAt: bigint;
  unwrapRequestedAt: bigint;
  buyCount: number;
  sellCount: number;
  revealTimeoutSnap: bigint;
  unwrapTimeoutSnap: bigint;
  minOrdersSnap: number;
  maxSlippageBpsSnap: number;
  auditorSnap: Address;
  buyTotalEnc: `0x${string}`;
  sellTotalEnc: `0x${string}`;
  unwrapRequestId: `0x${string}`;
  buyTotal: bigint;
  sellTotal: bigint;
  residualIn: bigint;
  buyOutTotal: bigint;
  sellOutTotal: bigint;
};

const readPool = (functionName: string, args: unknown[] = []) =>
  publicClient.readContract({
    address: A.pool,
    abi: KAIROS_POOL_ABI,
    functionName,
    args,
  } as never);

/** Poll a chain read on an interval; returns [data, loading, refetch]. */
export function usePoll<T>(
  fn: () => Promise<T>,
  deps: unknown[] = [],
  intervalMs = 12000,
): [T | undefined, boolean, () => void] {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);

  const run = useCallback(async () => {
    try {
      const v = await fn();
      setData(v);
    } catch {
      /* transient RPC failure — keep the previous value */
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    let alive = true;
    void run();
    const id = setInterval(() => {
      if (alive) void run();
    }, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [run, intervalMs]);

  return [data, loading, run];
}

export type PoolConfig = {
  currentEpochId: bigint;
  epochDuration: bigint;
  revealTimeout: bigint;
  unwrapTimeout: bigint;
  maxSlippageBps: number;
  minOrders: number;
  twapWindow: number;
  maxTickDeviation: number;
  auditor: Address;
  owner: Address;
};

export function usePoolConfig() {
  return usePoll<PoolConfig>(async () => {
    const [
      currentEpochId,
      epochDuration,
      revealTimeout,
      unwrapTimeout,
      maxSlippageBps,
      minOrders,
      twapWindow,
      maxTickDeviation,
      auditor,
      owner,
    ] = await Promise.all([
      readPool("currentEpochId"),
      readPool("epochDuration"),
      readPool("revealTimeout"),
      readPool("unwrapTimeout"),
      readPool("maxSlippageBps"),
      readPool("minOrders"),
      readPool("twapWindow"),
      readPool("maxTickDeviation"),
      readPool("auditor"),
      readPool("owner"),
    ]);
    return {
      currentEpochId,
      epochDuration,
      revealTimeout,
      unwrapTimeout,
      maxSlippageBps,
      minOrders,
      twapWindow,
      maxTickDeviation,
      auditor,
      owner,
    } as PoolConfig;
  }, []);
}

export function useEpoch(id?: bigint) {
  return usePoll<Epoch | undefined>(
    async () => (id === undefined ? undefined : ((await readPool("getEpoch", [id])) as Epoch)),
    [id?.toString()],
  );
}

/** The most recent `count` epochs, newest first. */
export function useRecentEpochs(count = 8) {
  return usePoll<{ id: bigint; epoch: Epoch }[]>(async () => {
    const current = (await readPool("currentEpochId")) as bigint;
    const ids: bigint[] = [];
    for (let i = 0n; i < BigInt(count) && current - i >= 1n; i++) ids.push(current - i);
    const epochs = await Promise.all(ids.map((id) => readPool("getEpoch", [id]) as Promise<Epoch>));
    return ids.map((id, i) => ({ id, epoch: epochs[i] }));
  }, [count]);
}

/** Public ERC-20 balances plus the *handles* of the confidential balances. */
export function useWalletState(address?: Address) {
  return usePoll(
    async () => {
      if (!address) return undefined;
      const [usdc, weth, cUsdcHandle, cWethHandle, opUsdc, opWeth, eth] = await Promise.all([
        publicClient.readContract({
          address: A.usdc,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: A.weth,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: A.cUSDC,
          abi: CTOKEN_ABI,
          functionName: "confidentialBalanceOf",
          args: [address],
        }) as Promise<`0x${string}`>,
        publicClient.readContract({
          address: A.cWETH,
          abi: CTOKEN_ABI,
          functionName: "confidentialBalanceOf",
          args: [address],
        }) as Promise<`0x${string}`>,
        publicClient.readContract({
          address: A.cUSDC,
          abi: CTOKEN_ABI,
          functionName: "isOperator",
          args: [address, A.pool],
        }) as Promise<boolean>,
        publicClient.readContract({
          address: A.cWETH,
          abi: CTOKEN_ABI,
          functionName: "isOperator",
          args: [address, A.pool],
        }) as Promise<boolean>,
        publicClient.getBalance({ address }),
      ]);
      return { usdc, weth, cUsdcHandle, cWethHandle, opUsdc, opWeth, eth };
    },
    [address],
    10000,
  );
}

/** Your position in a given epoch (handles only — amounts stay encrypted). */
export function usePosition(epochId?: bigint, address?: Address) {
  return usePoll(
    async () => {
      if (epochId === undefined || !address) return undefined;
      const [buy, sell, claimed] = await Promise.all([
        readPool("orderOf", [epochId, address, true]) as Promise<`0x${string}`>,
        readPool("orderOf", [epochId, address, false]) as Promise<`0x${string}`>,
        readPool("claimed", [epochId, address]) as Promise<boolean>,
      ]);
      return { buy, sell, claimed };
    },
    [epochId?.toString(), address],
  );
}

/** Live pool depth, used to warn about residual size limits. */
export function useUniswapDepth() {
  return usePoll(async () => {
    const [u, w] = await Promise.all([
      publicClient.readContract({
        address: A.usdc,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [A.uniPool],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: A.weth,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [A.uniPool],
      }) as Promise<bigint>,
    ]);
    return { usdc: u, weth: w };
  }, []);
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
