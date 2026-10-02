"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { NextPage } from "next";

const REPO = "https://github.com/piyushmali/hbar-stable-checkout";

const STEPS = [
  {
    title: "Customer pays HBAR",
    body: "The checkout link quotes the invoice in HBAR from the Chainlink HBAR/USD feed, plus a 1% buffer.",
  },
  {
    title: "Contract swaps on SaucerSwap",
    body: "StableCheckout swaps the HBAR to USDC in the same transaction. If the pool pays less than the Chainlink floor, it reverts.",
  },
  {
    title: "Merchant gets USDC, plus a receipt",
    body: "USDC lands in the merchant's payout account and a receipt is written to an HCS topic anyone can audit.",
  },
];

const DOCS = [
  { label: "Quickstart", href: `${REPO}#quickstart` },
  { label: "How the oracle floor works", href: `${REPO}#how-it-works` },
  { label: "Integration notes", href: `${REPO}#integration-notes` },
  { label: "Architecture", href: `${REPO}/blob/main/docs/architecture.md` },
];

type Health = { ok: boolean; network: string; contract: string | null; topicId: string | null };

const Home: NextPage = () => {
  const { data: health } = useQuery<Health>({
    queryKey: ["health"],
    queryFn: async () => (await fetch("/api/health")).json(),
  });

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-5 py-12">
      <section className="flex flex-col gap-4">
        <h1 className="m-0 text-4xl font-bold">Accept HBAR, settle in USDC</h1>
        <p className="m-0 max-w-2xl text-lg opacity-80">
          A Scaffold-HBAR template for merchant checkout on Hedera. Customers pay in HBAR, merchants receive USDC in the
          same transaction, a Chainlink price floor protects them from thin pools, and every payment leaves a public
          receipt on Hedera Consensus Service.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/merchant" className="btn btn-primary">
            Create an invoice
          </Link>
          <Link href="/receipts" className="btn">
            Browse receipts
          </Link>
        </div>
      </section>

      <section aria-labelledby="flow-heading">
        <h2 id="flow-heading" className="mb-4 mt-0 text-xl font-semibold">
          How a payment flows
        </h2>
        <ol className="m-0 grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="card border border-base-300 bg-base-100">
              <div className="card-body gap-2">
                <span className="badge badge-primary" aria-hidden>
                  {index + 1}
                </span>
                <h3 className="m-0 font-semibold">{step.title}</h3>
                <p className="m-0 text-sm opacity-80">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="status-heading" className="card border border-base-300 bg-base-100">
        <div className="card-body gap-3">
          <h2 id="status-heading" className="card-title m-0">
            This app
          </h2>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="opacity-70">Network</dt>
            <dd className="m-0">Hedera {health?.network ?? "…"}</dd>
            <dt className="opacity-70">StableCheckout</dt>
            <dd className="m-0 break-all font-mono text-xs">
              {health ? (health.contract ?? "not deployed: run yarn hardhat:deploy --network hederaTestnet") : "…"}
            </dd>
            <dt className="opacity-70">Receipt topic</dt>
            <dd className="m-0 font-mono text-xs">
              {health ? (health.topicId ?? "not set: run yarn hardhat:create-topic") : "…"}
            </dd>
          </dl>
        </div>
      </section>

      <section aria-labelledby="docs-heading">
        <h2 id="docs-heading" className="mb-3 mt-0 text-xl font-semibold">
          Docs
        </h2>
        <ul className="m-0 flex list-none flex-wrap gap-3 p-0">
          {DOCS.map(doc => (
            <li key={doc.href}>
              <a className="link" href={doc.href} target="_blank" rel="noreferrer">
                {doc.label}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
};

export default Home;
