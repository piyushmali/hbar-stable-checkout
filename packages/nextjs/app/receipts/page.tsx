"use client";

import { type FormEvent, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { NextPage } from "next";
import { isAddress } from "viem";
import { useAccount } from "wagmi";
import {
  type ApiError,
  type Health,
  type ReceiptsResponse,
  formatHbar,
  formatOraclePrice,
  formatUsd6,
  hashscanTopicUrl,
  hashscanTransactionUrl,
  mirrorTopicMessageUrl,
} from "~~/utils/checkout";

class ReceiptsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function fetchReceipts(merchant?: string): Promise<ReceiptsResponse> {
  const response = await fetch(`/api/receipts${merchant ? `?merchant=${merchant}` : ""}`);
  const body = (await response.json()) as ReceiptsResponse | ApiError;
  if ("error" in body) throw new ReceiptsError(body.error.code, body.error.message);
  return body;
}

const shorten = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const consensusDate = (timestamp: string) => new Date(Number(timestamp.split(".")[0]) * 1000).toLocaleString();

const ReceiptsPage: NextPage = () => {
  const { address } = useAccount();
  const [filterInput, setFilterInput] = useState("");
  const [merchant, setMerchant] = useState<string>();
  const { data: health } = useQuery<Health>({
    queryKey: ["health"],
    queryFn: async () => (await fetch("/api/health")).json(),
  });
  const topicConfigured = Boolean(health?.topicId);
  const { data, error, isLoading } = useQuery<ReceiptsResponse, ReceiptsError>({
    queryKey: ["receipts", merchant],
    queryFn: () => fetchReceipts(merchant),
    enabled: topicConfigured,
    refetchInterval: 15_000,
    retry: 2,
  });

  const applyFilter = (event: FormEvent) => {
    event.preventDefault();
    setMerchant(filterInput.trim() || undefined);
  };
  const filterInvalid = filterInput.trim() !== "" && !isAddress(filterInput.trim(), { strict: false });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-10">
      <header>
        <h1 className="m-0 text-3xl font-bold">Receipts</h1>
        <p className="mb-0 mt-2 opacity-80">
          Every settled payment is written to a Hedera Consensus Service topic after the server checks it against the
          mirror node. This feed reads the topic back from the mirror node, so anyone can audit it.
          {data && (
            <>
              {" "}
              Topic{" "}
              <a className="link" href={hashscanTopicUrl(data.network, data.topicId)} target="_blank" rel="noreferrer">
                {data.topicId}
              </a>{" "}
              on {data.network}.
            </>
          )}
        </p>
      </header>

      <form className="flex flex-wrap items-end gap-3" onSubmit={applyFilter}>
        <div className="flex flex-col gap-1">
          <label htmlFor="merchant-filter" className="text-sm font-medium">
            Merchant address
          </label>
          <input
            id="merchant-filter"
            className={`input input-bordered w-96 max-w-full ${filterInvalid ? "input-error" : ""}`}
            placeholder="0x…"
            value={filterInput}
            onChange={event => setFilterInput(event.target.value)}
            aria-invalid={filterInvalid}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={filterInvalid}>
          Filter
        </button>
        {address && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setFilterInput(address);
              setMerchant(address);
            }}
          >
            My receipts
          </button>
        )}
        {merchant && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setFilterInput("");
              setMerchant(undefined);
            }}
          >
            Clear
          </button>
        )}
      </form>

      {health && !topicConfigured ? (
        <div role="status" className="alert alert-warning">
          <span>
            No receipt topic is configured. Run <code>yarn hardhat:create-topic</code> and set <code>HCS_TOPIC_ID</code>{" "}
            in <code>packages/nextjs/.env.local</code>.
          </span>
        </div>
      ) : !health || isLoading ? (
        <span className="loading loading-dots" aria-label="Loading receipts" />
      ) : error ? (
        <div role="alert" className="alert alert-error">
          {error.message}
        </div>
      ) : data && data.receipts.length === 0 ? (
        <p className="m-0 opacity-80">No receipts{merchant ? " for this merchant" : ""} yet.</p>
      ) : (
        data && (
          <div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
            <table className="table">
              <caption className="sr-only">HCS payment receipts, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Paid</th>
                  <th scope="col">Invoice</th>
                  <th scope="col">Merchant</th>
                  <th scope="col">Payer</th>
                  <th scope="col">HBAR in</th>
                  <th scope="col">USDC out</th>
                  <th scope="col">HBAR/USD</th>
                  <th scope="col">Links</th>
                </tr>
              </thead>
              <tbody>
                {data.receipts.map(receipt => (
                  <tr key={receipt.txHash}>
                    <td className="whitespace-nowrap">{consensusDate(receipt.consensusTs)}</td>
                    <td className="whitespace-nowrap font-mono text-xs" title={receipt.invoiceId}>
                      {shorten(receipt.invoiceId)}
                    </td>
                    <td className="whitespace-nowrap font-mono text-xs" title={receipt.merchant}>
                      {shorten(receipt.merchant)}
                    </td>
                    <td className="whitespace-nowrap font-mono text-xs" title={receipt.payer}>
                      {shorten(receipt.payer)}
                    </td>
                    <td className="whitespace-nowrap">{formatHbar(BigInt(receipt.hbarIn))}</td>
                    <td className="whitespace-nowrap">{formatUsd6(BigInt(receipt.usdcOut))}</td>
                    <td>{formatOraclePrice(BigInt(receipt.oraclePrice))}</td>
                    <td className="whitespace-nowrap">
                      <a
                        className="link"
                        href={hashscanTransactionUrl(data.network, receipt.consensusTs)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Payment
                      </a>
                      {" · "}
                      <a
                        className="link"
                        href={hashscanTransactionUrl(data.network, receipt.messageTimestamp)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        HCS #{receipt.sequenceNumber}
                      </a>
                      {" · "}
                      <a
                        className="link"
                        href={mirrorTopicMessageUrl(data.network, data.topicId, receipt.sequenceNumber)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        JSON
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
};

export default ReceiptsPage;
