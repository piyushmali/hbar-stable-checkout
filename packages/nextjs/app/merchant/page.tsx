"use client";

import { type FormEvent, useState } from "react";
import { HederaAddressInput } from "@scaffold-hbar-ui/components";
import type { NextPage } from "next";
import { QRCodeSVG } from "qrcode.react";
import { type Address, type Hex, parseUnits, toHex } from "viem";
import { useAccount } from "wagmi";
import { DeployFirst } from "~~/components/checkout/DeployFirst";
import { UsdcAssociationStatus } from "~~/components/checkout/UsdcAssociation";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-hbar";
import {
  useCopyToClipboard,
  useDeployedContractInfo,
  useScaffoldReadContract,
  useScaffoldWriteContract,
  useTargetNetwork,
} from "~~/hooks/scaffold-hbar";
import { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, formatUsd6 } from "~~/utils/checkout";

const EXPIRY_OPTIONS = [
  { label: "15 minutes", seconds: 15 * 60 },
  { label: "1 hour", seconds: 60 * 60 },
  { label: "24 hours", seconds: 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
];
const USD_PATTERN = /^\d+(\.\d{1,6})?$/;

type CreatedInvoice = { id: Hex; usdAmount6: bigint; expiry: number };

const MerchantPage: NextPage = () => {
  const { address } = useAccount();
  const { data: checkout, isLoading } = useDeployedContractInfo({ contractName: "StableCheckout" });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-10">
      <header>
        <h1 className="m-0 text-3xl font-bold">Merchant</h1>
        <p className="mb-0 mt-2 opacity-80">
          Register a payout account, then create invoices that customers pay in HBAR. You receive USDC.
        </p>
      </header>
      {isLoading ? (
        <span className="loading loading-dots" aria-label="Loading" />
      ) : !checkout ? (
        <DeployFirst />
      ) : !address ? (
        <div className="card border border-base-300 bg-base-100">
          <div className="card-body items-start">
            <p className="m-0">Connect the wallet you want to manage invoices from.</p>
            <RainbowKitCustomConnectButton />
          </div>
        </div>
      ) : (
        <MerchantDashboard merchant={address} />
      )}
    </div>
  );
};

const MerchantDashboard = ({ merchant }: { merchant: Address }) => {
  const { data: profile, refetch } = useScaffoldReadContract({
    contractName: "StableCheckout",
    functionName: "merchants",
    args: [merchant],
  });
  const { data: usdc } = useScaffoldReadContract({ contractName: "StableCheckout", functionName: "usdc" });

  if (!profile) return <span className="loading loading-dots" aria-label="Loading merchant profile" />;
  const [payout, maxSlippageBps, registered] = profile;

  return (
    <>
      <ProfileForm
        // Re-mount with the saved values once a registration or update lands.
        key={`${registered}-${payout}-${maxSlippageBps}`}
        merchant={merchant}
        registered={registered}
        savedPayout={registered ? payout : merchant}
        savedSlippageBps={registered ? maxSlippageBps : DEFAULT_SLIPPAGE_BPS}
        onSaved={() => refetch()}
      />
      {registered && (
        <>
          <section className="card border border-base-300 bg-base-100">
            <div className="card-body gap-3">
              <h2 className="card-title m-0">USDC association</h2>
              <p className="m-0 text-sm opacity-80">
                Hedera accounts must be associated with an HTS token before they can hold it. Payments to an
                unassociated payout account revert, so customers are blocked until this is done.
              </p>
              <UsdcAssociationStatus account={payout} token={usdc} />
            </div>
          </section>
          <InvoiceCreator />
        </>
      )}
    </>
  );
};

type ProfileFormProps = {
  merchant: Address;
  registered: boolean;
  savedPayout: Address;
  savedSlippageBps: number;
  onSaved: () => void;
};

const ProfileForm = ({ merchant, registered, savedPayout, savedSlippageBps, onSaved }: ProfileFormProps) => {
  const { targetNetwork } = useTargetNetwork();
  const { writeContractAsync, isMining } = useScaffoldWriteContract({ contractName: "StableCheckout" });
  const [payoutInput, setPayoutInput] = useState<string>(savedPayout);
  const [payout, setPayout] = useState<Address | undefined>(savedPayout);
  const [slippagePercent, setSlippagePercent] = useState((savedSlippageBps / 100).toString());

  const slippageBps = Math.round(Number(slippagePercent) * 100);
  const slippageValid = Number.isFinite(slippageBps) && slippageBps >= 0 && slippageBps <= MAX_SLIPPAGE_BPS;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!payout || !slippageValid) return;
    try {
      await writeContractAsync({
        functionName: registered ? "updateMerchant" : "registerMerchant",
        args: [payout, slippageBps],
      });
      onSaved();
    } catch {
      // The transactor already showed the reason.
    }
  };

  return (
    <section className="card border border-base-300 bg-base-100">
      <form className="card-body gap-4" onSubmit={save}>
        <h2 className="card-title m-0">{registered ? "Payout settings" : "Register as a merchant"}</h2>
        <p className="m-0 text-sm opacity-80">
          Merchant account <code className="break-all">{merchant}</code>. USDC from every payment goes to the payout
          account, which can be this wallet or another Hedera account.
        </p>
        {/* The input has no id, so it is labelled by nesting. */}
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Payout account (0.0.n or 0x…)</span>
          <HederaAddressInput
            name="payout"
            value={payoutInput}
            onChange={setPayoutInput}
            onResolvedEvmChange={setPayout}
            chainId={targetNetwork.id}
          />
        </label>
        <div className="flex flex-col gap-1">
          <label htmlFor="slippage" className="text-sm font-medium">
            Slippage tolerance (%)
          </label>
          <input
            id="slippage"
            type="number"
            inputMode="decimal"
            min={0}
            max={MAX_SLIPPAGE_BPS / 100}
            step={0.05}
            className="input input-bordered w-40"
            value={slippagePercent}
            onChange={event => setSlippagePercent(event.target.value)}
            aria-describedby="slippage-help"
          />
          <p id="slippage-help" className="m-0 text-xs opacity-70">
            How far below the Chainlink price the swap may land, up to 3%. It has to cover SaucerSwap&apos;s 0.3% pool
            fee; 1% is a sensible default.
          </p>
        </div>
        <button type="submit" className="btn btn-primary w-fit" disabled={!payout || !slippageValid || isMining}>
          {isMining ? "Saving…" : registered ? "Update settings" : "Register"}
        </button>
      </form>
    </section>
  );
};

const InvoiceCreator = () => {
  const { writeContractAsync, isMining } = useScaffoldWriteContract({ contractName: "StableCheckout" });
  const [amount, setAmount] = useState("");
  const [expirySeconds, setExpirySeconds] = useState(EXPIRY_OPTIONS[1].seconds);
  const [created, setCreated] = useState<CreatedInvoice[]>([]);
  const amountValid = USD_PATTERN.test(amount.trim()) && parseUnits(amount.trim(), 6) > 0n;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!amountValid) return;
    const usdAmount6 = parseUnits(amount.trim(), 6);
    const id = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const expiry = Math.floor(Date.now() / 1000) + expirySeconds;
    try {
      await writeContractAsync({ functionName: "createInvoice", args: [id, usdAmount6, BigInt(expiry)] });
      setCreated(list => [{ id, usdAmount6, expiry }, ...list]);
      setAmount("");
    } catch {
      // The transactor already showed the reason.
    }
  };

  return (
    <section className="card border border-base-300 bg-base-100">
      <div className="card-body gap-4">
        <h2 className="card-title m-0">Create an invoice</h2>
        <form className="flex flex-wrap items-end gap-3" onSubmit={create}>
          <div className="flex flex-col gap-1">
            <label htmlFor="amount" className="text-sm font-medium">
              Amount (USD)
            </label>
            <input
              id="amount"
              inputMode="decimal"
              placeholder="25.00"
              className="input input-bordered w-40"
              value={amount}
              onChange={event => setAmount(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="expiry" className="text-sm font-medium">
              Expires in
            </label>
            <select
              id="expiry"
              className="select select-bordered"
              value={expirySeconds}
              onChange={event => setExpirySeconds(Number(event.target.value))}
            >
              {EXPIRY_OPTIONS.map(option => (
                <option key={option.seconds} value={option.seconds}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-primary" disabled={!amountValid || isMining}>
            {isMining ? "Creating…" : "Create invoice"}
          </button>
        </form>
        {created.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Invoices created in this session">
            {created.map(invoice => (
              <InvoiceLink key={invoice.id} invoice={invoice} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
};

const InvoiceLink = ({ invoice }: { invoice: CreatedInvoice }) => {
  const { copyToClipboard, isCopiedToClipboard } = useCopyToClipboard();
  const url = `${window.location.origin}/pay/${invoice.id}`;
  return (
    <li className="flex flex-wrap items-center gap-4 rounded-box border border-base-300 p-4">
      <div className="rounded bg-white p-2">
        <QRCodeSVG value={url} size={128} title={`QR code for the ${formatUsd6(invoice.usdAmount6)} checkout link`} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-lg font-semibold">{formatUsd6(invoice.usdAmount6)}</span>
        <span className="text-xs opacity-70">Expires {new Date(invoice.expiry * 1000).toLocaleString()}</span>
        <a href={url} className="link break-all text-sm">
          {url}
        </a>
        <button type="button" className="btn btn-xs w-fit" onClick={() => copyToClipboard(url)}>
          {isCopiedToClipboard ? "Copied" : "Copy link"}
        </button>
      </div>
    </li>
  );
};

export default MerchantPage;
