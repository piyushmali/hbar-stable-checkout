"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { NextPage } from "next";
import { type Hex, isHex } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { DeployFirst } from "~~/components/checkout/DeployFirst";
import { useUsdcAssociation } from "~~/components/checkout/UsdcAssociation";
import { HederaAddress, RainbowKitCustomConnectButton } from "~~/components/scaffold-hbar";
import {
  useDeployedContractInfo,
  useScaffoldReadContract,
  useScaffoldWriteContract,
  useTargetNetwork,
} from "~~/hooks/scaffold-hbar";
import {
  type ApiError,
  QUOTE_BUFFER_BPS,
  type RecordResult,
  WEIBARS_PER_TINYBAR,
  describeCheckoutError,
  formatHbar,
  formatOraclePrice,
  formatUsd6,
  hashscanTopicUrl,
  hashscanTransactionUrl,
  mirrorContractResultUrl,
  mirrorTopicMessageUrl,
  withGasHeadroom,
} from "~~/utils/checkout";
import { type HederaNetwork, chainIdToHederaNetwork } from "~~/utils/scaffold-hbar";

// InvoiceStatus in StableCheckout.sol
const OPEN = 1;
const PAID = 2;
const STATUS_LABELS = ["Not found", "Open", "Paid", "Expired"];
const RECEIPT_ATTEMPTS = 6;

type ReceiptState =
  | { phase: "recording" }
  | { phase: "recorded"; result: RecordResult }
  | { phase: "failed"; message: string };

/** Record the HCS receipt, backing off while the mirror node catches up with the payment (1, 2, 4, 8, 16 s). */
async function postReceipt(txHash: Hex): Promise<RecordResult> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch("/api/receipts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash }),
    });
    const body = (await response.json()) as RecordResult | ApiError;
    if (response.ok) return body as RecordResult;
    const retriable = response.status === 404 || response.status === 504;
    if (!retriable || attempt + 1 >= RECEIPT_ATTEMPTS) throw new Error((body as ApiError).error.message);
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}

const PayPage: NextPage = () => {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const { data: checkout, isLoading } = useDeployedContractInfo({ contractName: "StableCheckout" });
  const validId = isHex(invoiceId) && invoiceId.length === 66;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-5 py-10">
      <h1 className="m-0 text-3xl font-bold">Pay with HBAR</h1>
      {!validId ? (
        <div role="alert" className="alert alert-error">
          This checkout link is malformed. Ask the merchant for a new one.
        </div>
      ) : isLoading ? (
        <span className="loading loading-dots" aria-label="Loading" />
      ) : !checkout ? (
        <DeployFirst />
      ) : (
        <Checkout invoiceId={invoiceId as Hex} />
      )}
    </div>
  );
};

const Checkout = ({ invoiceId }: { invoiceId: Hex }) => {
  const { address } = useAccount();
  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient({ chainId: targetNetwork.id });
  const { data: checkout } = useDeployedContractInfo({ contractName: "StableCheckout" });
  const network = chainIdToHederaNetwork(targetNetwork.id);
  const [txHash, setTxHash] = useState<Hex>();
  const [payError, setPayError] = useState<string>();
  const [receipt, setReceipt] = useState<ReceiptState>();

  const { data: invoice } = useScaffoldReadContract({
    contractName: "StableCheckout",
    functionName: "invoiceOf",
    args: [invoiceId],
  });
  const [merchant, usdAmount6, expiry, status] = invoice ?? [];
  const { data: profile } = useScaffoldReadContract({
    contractName: "StableCheckout",
    functionName: "merchants",
    args: [merchant],
  });
  const { data: usdc } = useScaffoldReadContract({ contractName: "StableCheckout", functionName: "usdc" });
  const { data: price, error: priceError } = useScaffoldReadContract({
    contractName: "StableCheckout",
    functionName: "latestPrice",
  });
  const { data: quote } = useScaffoldReadContract({
    contractName: "StableCheckout",
    functionName: "quoteTinybars",
    args: [usdAmount6],
  });
  const tinybars = quote === undefined ? undefined : quote + (quote * QUOTE_BUFFER_BPS) / 10_000n;
  const { data: preview } = useScaffoldReadContract({
    contractName: "StableCheckout",
    functionName: "previewPay",
    args: [invoiceId, tinybars],
  });
  const { data: association } = useUsdcAssociation(profile?.[0], usdc);
  const { writeContractAsync, isMining } = useScaffoldWriteContract({ contractName: "StableCheckout" });

  if (!invoice) return <span className="loading loading-dots" aria-label="Loading invoice" />;
  if (status === 0) {
    return (
      <div role="alert" className="alert alert-error">
        Invoice not found on {targetNetwork.name}. Check that the link and network are right.
      </div>
    );
  }

  const [oracleUsdc, minUsdcOut, poolUsdc] = preview ?? [];
  const poolBelowFloor = poolUsdc !== undefined && minUsdcOut !== undefined && poolUsdc < minUsdcOut;
  const payoutBlocked = association?.status === "not-associated" || association?.status === "no-account";
  const blocker = priceError
    ? describeCheckoutError(priceError)
    : poolBelowFloor
      ? "SaucerSwap currently pays less than the Chainlink floor, so a payment would revert. Try again later."
      : payoutBlocked
        ? "The merchant's payout account cannot receive USDC yet (it is not associated with the token)."
        : undefined;

  const pay = async () => {
    if (!tinybars || !address || !publicClient || !checkout) return;
    setPayError(undefined);
    const value = tinybars * WEIBARS_PER_TINYBAR;
    try {
      // The relay simulates the swap and the HTS calls. A revert surfaces here, before the wallet opens.
      const estimate = await publicClient.estimateContractGas({
        address: checkout.address,
        abi: checkout.abi,
        functionName: "pay",
        args: [invoiceId],
        value,
        account: address,
      });
      const hash = await writeContractAsync({
        functionName: "pay",
        args: [invoiceId],
        value,
        gas: withGasHeadroom(estimate),
      });
      if (!hash) return;
      setTxHash(hash);
      setReceipt({ phase: "recording" });
      postReceipt(hash)
        .then(result => setReceipt({ phase: "recorded", result }))
        .catch((error: Error) => setReceipt({ phase: "failed", message: error.message }));
    } catch (error) {
      setPayError(describeCheckoutError(error));
    }
  };

  return (
    <>
      <section className="card border border-base-300 bg-base-100" aria-labelledby="invoice-heading">
        <div className="card-body gap-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="invoice-heading" className="m-0 text-sm font-medium uppercase tracking-wide opacity-70">
                Amount due
              </h2>
              <p className="m-0 text-4xl font-bold">{usdAmount6 !== undefined && formatUsd6(usdAmount6)}</p>
            </div>
            <span className={`badge ${status === OPEN ? "badge-success" : "badge-ghost"}`}>
              {STATUS_LABELS[Number(status)]}
            </span>
          </div>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="opacity-70">Merchant</dt>
            <dd className="m-0 flex">
              <HederaAddress address={merchant} chain={targetNetwork} />
            </dd>
            <dt className="opacity-70">Expires</dt>
            <dd className="m-0">{expiry !== undefined && new Date(Number(expiry) * 1000).toLocaleString()}</dd>
            <dt className="opacity-70">Invoice</dt>
            <dd className="m-0 break-all font-mono text-xs">{invoiceId}</dd>
          </dl>
        </div>
      </section>

      <section className="card border border-base-300 bg-base-100" aria-labelledby="quote-heading">
        <div className="card-body gap-3">
          <h2 id="quote-heading" className="card-title m-0">
            Quote
          </h2>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="opacity-70">Chainlink HBAR/USD</dt>
            <dd className="m-0">
              {price
                ? `${formatOraclePrice(price[0])}, updated ${new Date(Number(price[1]) * 1000).toLocaleTimeString()}`
                : priceError
                  ? "Unavailable"
                  : "…"}
            </dd>
            <dt className="opacity-70">You send</dt>
            <dd className="m-0 font-semibold">
              {tinybars !== undefined ? `${formatHbar(tinybars)} (quote + 1% buffer)` : "…"}
            </dd>
            <dt className="opacity-70">Oracle value</dt>
            <dd className="m-0">{oracleUsdc !== undefined ? formatUsd6(oracleUsdc) : "…"}</dd>
            <dt className="opacity-70">Merchant floor</dt>
            <dd className="m-0">
              {minUsdcOut !== undefined
                ? `${formatUsd6(minUsdcOut)} USDC (oracle value minus ${Number(profile?.[1] ?? 0) / 100}% slippage)`
                : "…"}
            </dd>
            <dt className="opacity-70">SaucerSwap pays now</dt>
            <dd className={`m-0 ${poolBelowFloor ? "text-error" : ""}`}>
              {poolUsdc !== undefined ? `${formatUsd6(poolUsdc)} USDC` : "…"}
            </dd>
          </dl>
          <p className="m-0 text-xs opacity-70">
            The whole amount is swapped to USDC for the merchant. If the pool would pay less than the floor, the
            transaction reverts and you keep your HBAR (minus network fees).
          </p>
        </div>
      </section>

      {txHash ? (
        <section role="status" className="alert alert-success">
          <div className="flex flex-col items-start gap-2">
            <p className="m-0 font-semibold">Paid. The merchant received USDC in the same transaction.</p>
            <a className="link" href={hashscanTransactionUrl(network, txHash)} target="_blank" rel="noreferrer">
              View the payment on HashScan
            </a>
            <a
              className="link text-sm"
              href={mirrorContractResultUrl(network, txHash)}
              target="_blank"
              rel="noreferrer"
            >
              Mirror node contract result
            </a>
            <ReceiptStatus state={receipt} network={network} />
          </div>
        </section>
      ) : status === PAID ? (
        <div role="status" className="alert alert-success">
          <span>
            This invoice has been paid. Its receipt is on the{" "}
            <Link href="/receipts" className="link">
              receipts page
            </Link>
            .
          </span>
        </div>
      ) : status !== OPEN ? (
        <div role="status" className="alert alert-warning">
          This invoice has expired. Ask the merchant for a new checkout link.
        </div>
      ) : !address ? (
        <div className="flex flex-col items-start gap-2">
          <p className="m-0">Connect a Hedera ECDSA wallet with enough HBAR to pay.</p>
          <RainbowKitCustomConnectButton />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {blocker && (
            <div role="alert" className="alert alert-warning">
              {blocker}
            </div>
          )}
          {payError && (
            <div role="alert" className="alert alert-error">
              {payError}
            </div>
          )}
          <button
            type="button"
            className="btn btn-primary btn-lg"
            onClick={pay}
            disabled={Boolean(blocker) || tinybars === undefined || isMining}
          >
            {isMining ? "Paying…" : tinybars !== undefined ? `Pay ${formatHbar(tinybars)}` : "Pay with HBAR"}
          </button>
        </div>
      )}
    </>
  );
};

const ReceiptStatus = ({ state, network }: { state?: ReceiptState; network: HederaNetwork }) => {
  if (!state || state.phase === "recording") {
    return <p className="m-0 text-sm">Writing the receipt to Hedera Consensus Service…</p>;
  }
  if (state.phase === "failed") {
    return <p className="m-0 text-sm">The receipt was not recorded: {state.message}</p>;
  }
  const { topicId, sequenceNumber } = state.result;
  return (
    <p className="m-0 text-sm">
      Receipt #{sequenceNumber} is on HCS topic{" "}
      <a className="link" href={hashscanTopicUrl(network, topicId)} target="_blank" rel="noreferrer">
        {topicId}
      </a>{" "}
      (
      <a
        className="link"
        href={mirrorTopicMessageUrl(network, topicId, sequenceNumber)}
        target="_blank"
        rel="noreferrer"
      >
        mirror node
      </a>
      ).
    </p>
  );
};

export default PayPage;
