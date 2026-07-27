"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  createWalletClient,
  custom,
  type Address,
  type WalletClient,
} from "viem";
import { sepolia } from "viem/chains";
import { publicClient } from "./chain";

/**
 * Minimal EIP-1193 wallet layer. Deliberately dependency-light: this app needs
 * one chain and one account, so a full connector kit would be more surface than
 * substance.
 */

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (e: string, cb: (...a: never[]) => void) => void;
  removeListener?: (e: string, cb: (...a: never[]) => void) => void;
};

type Ctx = {
  address?: Address;
  chainId?: number;
  wrongChain: boolean;
  hasWallet: boolean;
  connecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
  walletClient?: WalletClient;
};

const WalletCtx = createContext<Ctx>({
  wrongChain: false,
  hasWallet: false,
  connecting: false,
  connect: async () => {},
  disconnect: () => {},
  switchChain: async () => {},
});

const eth = (): Eip1193 | undefined =>
  typeof window === "undefined"
    ? undefined
    : ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? undefined);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [connecting, setConnecting] = useState(false);
  const [hasWallet, setHasWallet] = useState(false);

  useEffect(() => {
    const provider = eth();
    setHasWallet(!!provider);
    if (!provider) return;

    void (async () => {
      const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
      if (accounts?.[0]) setAddress(accounts[0] as Address);
      const cid = (await provider.request({ method: "eth_chainId" })) as string;
      setChainId(Number.parseInt(cid, 16));
    })();

    const onAccounts = (...args: never[]) => {
      const accounts = args[0] as unknown as string[];
      setAddress(accounts?.[0] as Address | undefined);
    };
    const onChain = (...args: never[]) => {
      setChainId(Number.parseInt(args[0] as unknown as string, 16));
    };
    provider.on?.("accountsChanged", onAccounts);
    provider.on?.("chainChanged", onChain);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const connect = useCallback(async () => {
    const provider = eth();
    if (!provider) {
      window.open("https://metamask.io/download/", "_blank");
      return;
    }
    setConnecting(true);
    try {
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      setAddress(accounts?.[0] as Address);
      const cid = (await provider.request({ method: "eth_chainId" })) as string;
      setChainId(Number.parseInt(cid, 16));
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchChain = useCallback(async () => {
    const provider = eth();
    if (!provider) return;
    const hex = `0x${sepolia.id.toString(16)}`;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hex,
            chainName: "Ethereum Sepolia",
            nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
            blockExplorerUrls: ["https://sepolia.etherscan.io"],
          },
        ],
      });
    }
  }, []);

  const walletClient = useMemo(() => {
    const provider = eth();
    if (!provider || !address) return undefined;
    return createWalletClient({
      account: address,
      chain: sepolia,
      transport: custom(provider as never),
    });
  }, [address]);

  const value: Ctx = {
    address,
    chainId,
    wrongChain: !!address && chainId !== undefined && chainId !== sepolia.id,
    hasWallet,
    connecting,
    connect,
    disconnect: () => setAddress(undefined),
    switchChain,
    walletClient,
  };

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export const useWallet = () => useContext(WalletCtx);

/** Send a transaction and wait for its receipt; throws on revert. */
export async function sendTx(
  walletClient: WalletClient,
  params: Parameters<WalletClient["writeContract"]>[0],
) {
  const hash = await walletClient.writeContract(params);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction reverted");
  return hash;
}
