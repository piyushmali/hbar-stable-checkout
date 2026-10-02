"use client";

import { useQuery } from "@tanstack/react-query";
import { type Address, isAddressEqual } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { useTargetNetwork, useTransactor } from "~~/hooks/scaffold-hbar";
import { HEDERA_NETWORKS, describeCheckoutError, withGasHeadroom } from "~~/utils/checkout";
import { chainIdToHederaNetwork, notification } from "~~/utils/scaffold-hbar";

const MIRROR_TIMEOUT_MS = 8_000;
// HIP-719: every HTS token address answers associate() on behalf of the calling account.
const HRC719_ABI = [
  { type: "function", name: "associate", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "nonpayable" },
] as const;

export type UsdcAssociation = {
  status: "associated" | "auto-association" | "not-associated" | "no-account";
  tokenId: string;
  accountId?: string;
};

async function mirrorJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`The mirror node answered ${response.status}.`);
  return (await response.json()) as T;
}

/** Whether `account` can receive the USDC HTS token, read from the mirror node. */
export function useUsdcAssociation(account: Address | undefined, token: Address | undefined) {
  const { targetNetwork } = useTargetNetwork();
  const network = chainIdToHederaNetwork(targetNetwork.id);
  return useQuery({
    queryKey: ["usdc-association", network, account, token],
    enabled: Boolean(account && token),
    // The mirror node trails consensus by a few seconds, so keep polling until an association shows up.
    refetchInterval: query => (query.state.data?.status === "associated" ? false : 5_000),
    queryFn: async (): Promise<UsdcAssociation> => {
      const accounts = `${HEDERA_NETWORKS[network].mirrorNodeUrl}/api/v1/accounts`;
      const tokenId = `0.0.${BigInt(token as Address)}`;
      const info = await mirrorJson<{ account: string; max_automatic_token_associations: number }>(
        `${accounts}/${account}`,
      );
      if (!info) return { status: "no-account", tokenId };

      const relation = await mirrorJson<{ tokens: unknown[] }>(
        `${accounts}/${info.account}/tokens?token.id=${tokenId}`,
      );
      if (relation?.tokens.length) return { status: "associated", tokenId, accountId: info.account };

      // Free automatic association slots (-1 = unlimited) let HTS associate on the first transfer.
      const slots = info.max_automatic_token_associations;
      if (slots === -1) return { status: "auto-association", tokenId, accountId: info.account };
      if (slots > 0) {
        // ponytail: counts used slots on the first 100 token relationships only.
        const page = await mirrorJson<{ tokens: { automatic_association: boolean }[] }>(
          `${accounts}/${info.account}/tokens?limit=100`,
        );
        const used = page?.tokens.filter(entry => entry.automatic_association).length ?? 0;
        if (used < slots) return { status: "auto-association", tokenId, accountId: info.account };
      }
      return { status: "not-associated", tokenId, accountId: info.account };
    },
  });
}

/** Association status of a payout account, with a one-click HIP-719 associate() when it is the connected wallet. */
export const UsdcAssociationStatus = ({ account, token }: { account?: Address; token?: Address }) => {
  const { address: connected } = useAccount();
  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient({ chainId: targetNetwork.id });
  const { data, isLoading, isError, refetch } = useUsdcAssociation(account, token);
  const writeTx = useTransactor();
  const { writeContractAsync, isPending } = useWriteContract();

  if (!account || !token || isLoading) {
    return <p className="m-0 text-sm opacity-70">Checking USDC association…</p>;
  }
  if (isError || !data) {
    return (
      <p className="m-0 text-sm">
        Could not reach the mirror node.{" "}
        <button type="button" className="link" onClick={() => refetch()}>
          Retry
        </button>
      </p>
    );
  }

  const isConnectedAccount = connected !== undefined && isAddressEqual(account, connected);
  const associate = async () => {
    if (!publicClient || !connected) return;
    const request = { address: token, abi: HRC719_ABI, functionName: "associate", account: connected } as const;
    let gas: bigint;
    try {
      gas = withGasHeadroom(await publicClient.estimateContractGas(request));
    } catch (error) {
      notification.error(describeCheckoutError(error));
      return;
    }
    try {
      await writeTx(() => writeContractAsync({ ...request, gas }));
      await refetch();
    } catch {
      // useTransactor already showed the error.
    }
  };

  return (
    <div className="flex flex-col gap-2 text-sm" aria-live="polite">
      {data.status === "associated" && <span className="badge badge-success">Associated with USDC {data.tokenId}</span>}
      {data.status === "auto-association" && (
        <span className="badge badge-info">
          A free auto-association slot will associate USDC {data.tokenId} on the first payout
        </span>
      )}
      {data.status === "no-account" && (
        <span className="badge badge-warning">No Hedera account exists at this address yet</span>
      )}
      {data.status === "not-associated" && (
        <>
          <span className="badge badge-warning">Not associated with USDC {data.tokenId}</span>
          {isConnectedAccount ? (
            <button type="button" className="btn btn-sm btn-primary w-fit" onClick={associate} disabled={isPending}>
              {isPending ? "Associating…" : "Associate USDC"}
            </button>
          ) : (
            <span className="opacity-70">Connect as the payout account to associate it, or use a Hedera wallet.</span>
          )}
        </>
      )}
    </div>
  );
};
