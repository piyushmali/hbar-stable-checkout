import { useTargetNetwork } from "~~/hooks/scaffold-hbar";

/** Shown instead of a page body while StableCheckout has no deployment on the selected network. */
export const DeployFirst = () => {
  const { targetNetwork } = useTargetNetwork();
  return (
    <div role="status" className="alert alert-warning">
      <div className="flex w-full flex-col gap-3">
        <p className="m-0 font-semibold">StableCheckout is not deployed on {targetNetwork.name} yet.</p>
        <p className="m-0 text-sm">Deploy it, then reload this page:</p>
        <pre className="m-0 w-full overflow-x-auto rounded bg-base-100 p-3 text-xs text-base-content">
          <code>{`# packages/hardhat/.env: DEPLOYER_PRIVATE_KEY=0x… (ECDSA, funded)
yarn hardhat:deploy --network hederaTestnet`}</code>
        </pre>
      </div>
    </div>
  );
};
