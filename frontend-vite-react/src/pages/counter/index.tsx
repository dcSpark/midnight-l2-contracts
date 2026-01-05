import { Loading } from "@/components/loading";
import { useEffect, useMemo, useState } from "react";
import { PlusCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { ModeToggle } from "@/components/mode-toggle";
import { useContractSubscription } from "@/modules/midnight/counter-sdk/hooks/use-contract-subscription";
import { DEFAULT_VERIFIER_SECRET_KEYS } from "@/modules/midnight/counter-sdk/api/contractController";
import {
  encodeCoinPublicKey,
  fromHex,
  toHex,
} from "@midnight-ntwrk/compact-runtime";

const truncateMiddle = (value: string, keep = 10) => {
  if (value.length <= keep * 2 + 2) {
    return value;
  }
  return `${value.slice(0, keep + 2)}...${value.slice(-keep)}`;
};

const formatBytes = (bytes?: Uint8Array) => {
  if (!bytes) {
    return "Not fetched";
  }
  return `0x${toHex(bytes)}`;
};

const formatBigint = (value?: bigint) => {
  if (value === undefined) {
    return "Not fetched";
  }
  return value.toString();
};

const parseBytes32 = (label: string, value: string) => {
  const normalized = value.trim().replace(/^0x/i, "");
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  if (!/^[0-9a-fA-F]+$/.test(normalized)) {
    throw new Error(`${label} must be hex`);
  }
  if (normalized.length > 64) {
    throw new Error(`${label} must be 32 bytes or less`);
  }
  return fromHex(normalized.padStart(64, "0"));
};

const parseBigint = (label: string, value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return BigInt(trimmed);
};

const nowSeconds = () => Math.floor(Date.now() / 1000).toString();

export const Counter = () => {
  const { deployedContractAPI, derivedState, onDeploy, providers } =
    useContractSubscription();
  const [deployedAddress, setDeployedAddress] = useState<string | undefined>(
    undefined
  );
  const [appLoading, setAppLoading] = useState(true);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [depositAmountInput, setDepositAmountInput] =
    useState<string>("0");
  const [depositRecipientInput, setDepositRecipientInput] =
    useState<string>("");
  const [depositGasLimitInput, setDepositGasLimitInput] =
    useState<string>("100000");
  const [depositTimestampInput, setDepositTimestampInput] =
    useState<string>(nowSeconds());
  const [withdrawRecipientInput, setWithdrawRecipientInput] =
    useState<string>("");
  const [withdrawAmountInput, setWithdrawAmountInput] =
    useState<string>("0");

  useEffect(() => {
    if (derivedState) {
      setAppLoading(false);
    }
  }, [derivedState]);

  const connectedAddress = deployedContractAPI?.deployedContractAddress;

  const walletRecipientHex = useMemo(() => {
    const coinPublicKey = providers?.walletProvider?.getCoinPublicKey();
    if (!coinPublicKey) {
      return undefined;
    }
    return toHex(encodeCoinPublicKey(coinPublicKey));
  }, [providers?.walletProvider]);

  const deployNew = async () => {
    setActionError(undefined);
    const { address } = await onDeploy();
    setDeployedAddress(address);
  };

  const refreshQueries = async () => {
    if (!deployedContractAPI) {
      return;
    }
    setActionError(undefined);
    try {
      await deployedContractAPI.refreshQueries();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Failed to refresh queries"
      );
    }
  };

  const submitDeposit = async () => {
    if (!deployedContractAPI) {
      return;
    }
    setActionError(undefined);
    try {
      const amount = parseBigint("Deposit amount", depositAmountInput);
      if (amount <= 0n) {
        throw new Error("Deposit amount must be greater than zero");
      }
      const recipientHex =
        depositRecipientInput.trim() || walletRecipientHex || "";
      const l2Recipient = parseBytes32("L2 recipient", recipientHex);
      const gasLimit = parseBigint("Gas limit", depositGasLimitInput);
      const timestamp = parseBigint(
        "Timestamp",
        depositTimestampInput || nowSeconds()
      );
      await deployedContractAPI.depositNIGHT(
        amount,
        l2Recipient,
        gasLimit,
        timestamp
      );
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Failed to deposit NIGHT"
      );
    }
  };

  const submitWithdraw = async () => {
    if (!deployedContractAPI) {
      return;
    }
    setActionError(undefined);
    try {
      const recipientHex =
        withdrawRecipientInput.trim() || walletRecipientHex || "";
      const recipient = parseBytes32("Recipient", recipientHex);
      const amount = parseBigint("Amount", withdrawAmountInput);
      await deployedContractAPI.withdrawNIGHT(recipient, amount);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Failed to withdraw NIGHT"
      );
    }
  };

  const actionMessages = useMemo(() => {
    if (!derivedState?.turns) {
      return [];
    }
    return Object.entries(derivedState.turns)
      .filter(([, value]) => value)
      .map(([key, value]) => ({ key, value: value as string }));
  }, [derivedState?.turns]);

  return (
    <div className="min-h-screen bg-background py-12 px-4 sm:px-6 lg:px-8">
      {appLoading && <Loading />}
      <div className="max-w-5xl mx-auto space-y-8">
        <div className="flex justify-between items-center">
          <div className="text-center md:text-left">
            <h1 className="text-4xl font-bold text-foreground mb-2">
              Bridge Contract
            </h1>
            <p className="text-xl text-muted-foreground">
              Deposit NIGHT on L1 and observe the cross-domain queue
            </p>
          </div>
          <div className="hidden md:block">
            <ModeToggle />
          </div>
        </div>

        <Card>
          <CardHeader className="text-center">
            <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <PlusCircle className="w-10 h-10 text-primary" />
            </div>
            <CardTitle className="text-2xl">Deployment</CardTitle>
            <CardDescription className="max-w-md mx-auto">
              Deploy the bridge with default verifier keys
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Button onClick={deployNew} className="gap-2">
                  <PlusCircle className="w-5 h-5" />
                  <span>Deploy New Contract</span>
                </Button>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
                Default verifier secret keys: {DEFAULT_VERIFIER_SECRET_KEYS.join(", ")}
              </div>
              {deployedAddress && (
                <div className="p-4 bg-muted rounded-lg">
                  <p className="text-sm font-medium text-muted-foreground mb-1">
                    Deployed Contract
                  </p>
                  <p className="text-sm font-mono break-all">
                    {deployedAddress}
                  </p>
                </div>
              )}
              {connectedAddress && (
                <div className="p-4 bg-muted rounded-lg">
                  <p className="text-sm font-medium text-muted-foreground mb-1">
                    Connected Contract
                  </p>
                  <p className="text-sm font-mono break-all">
                    {connectedAddress}
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Deposit to L2</CardTitle>
              <CardDescription>
                Send NIGHT from L1 into the cross-domain queue
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-3">
                <input
                  value={depositAmountInput}
                  onChange={(event) => setDepositAmountInput(event.target.value)}
                  placeholder="Amount (bigint)"
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                />
                <input
                  value={depositRecipientInput}
                  onChange={(event) =>
                    setDepositRecipientInput(event.target.value)
                  }
                  placeholder="L2 recipient (hex, 32 bytes)"
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      walletRecipientHex &&
                      setDepositRecipientInput(walletRecipientHex)
                    }
                    disabled={!walletRecipientHex}
                  >
                    Use wallet recipient
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setDepositTimestampInput(nowSeconds())}
                  >
                    Use current time
                  </Button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input
                    value={depositGasLimitInput}
                    onChange={(event) =>
                      setDepositGasLimitInput(event.target.value)
                    }
                    placeholder="Gas limit"
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  />
                  <input
                    value={depositTimestampInput}
                    onChange={(event) =>
                      setDepositTimestampInput(event.target.value)
                    }
                    placeholder="Timestamp (unix seconds)"
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Requires shielded NIGHT balance in your wallet.
              </p>
              <Button
                onClick={submitDeposit}
                disabled={!deployedContractAPI}
                variant={deployedContractAPI ? "default" : "secondary"}
              >
                Submit depositNIGHT
              </Button>
              {derivedState?.query.lastDeposit && (
                <div className="rounded-lg border border-border bg-background p-3">
                  <p className="text-sm font-medium text-muted-foreground mb-2">
                    Last deposit
                  </p>
                  <p className="text-xs font-mono">
                    queueIndex: {derivedState.query.lastDeposit.queueIndex.toString()}
                  </p>
                  <p
                    className="text-xs font-mono break-all"
                    title={`0x${toHex(derivedState.query.lastDeposit.messageHash)}`}
                  >
                    messageHash: 0x{toHex(derivedState.query.lastDeposit.messageHash)}
                  </p>
                  <p
                    className="text-xs font-mono break-all"
                    title={`0x${toHex(derivedState.query.lastDeposit.rollingHash)}`}
                  >
                    rollingHash: 0x{toHex(derivedState.query.lastDeposit.rollingHash)}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Withdraw NIGHT</CardTitle>
              <CardDescription>
                Build the L2 withdrawal queue entry
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-3">
                <input
                  value={withdrawRecipientInput}
                  onChange={(event) =>
                    setWithdrawRecipientInput(event.target.value)
                  }
                  placeholder="Recipient (hex, 32 bytes)"
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                />
                <input
                  value={withdrawAmountInput}
                  onChange={(event) =>
                    setWithdrawAmountInput(event.target.value)
                  }
                  placeholder="Amount (bigint)"
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    walletRecipientHex &&
                    setWithdrawRecipientInput(walletRecipientHex)
                  }
                  disabled={!walletRecipientHex}
                >
                  Use wallet recipient
                </Button>
              </div>
              <Button
                onClick={submitWithdraw}
                disabled={!deployedContractAPI}
                variant={deployedContractAPI ? "default" : "secondary"}
              >
                Submit withdrawNIGHT
              </Button>
              {derivedState?.query.lastWithdraw && (
                <div className="rounded-lg border border-border bg-background p-3">
                  <p className="text-sm font-medium text-muted-foreground mb-2">
                    Last withdrawNIGHT
                  </p>
                  <p className="text-xs font-mono">
                    nonce: {derivedState.query.lastWithdraw.nonce.toString()}
                  </p>
                  <p
                    className="text-xs font-mono break-all"
                    title={`0x${toHex(derivedState.query.lastWithdraw.messageHash)}`}
                  >
                    messageHash: 0x{toHex(derivedState.query.lastWithdraw.messageHash)}
                  </p>
                  <p
                    className="text-xs font-mono break-all"
                    title={`0x${toHex(derivedState.query.lastWithdraw.leafHash)}`}
                  >
                    leafHash: 0x{toHex(derivedState.query.lastWithdraw.leafHash)}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Rollup State</CardTitle>
              <CardDescription>Queue pointers and liquidity</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-sm font-medium text-muted-foreground mb-1">
                  Next Cross-Domain Message Index
                </p>
                <p className="text-sm font-mono">
                  {formatBigint(derivedState?.query.nextCrossDomainMessageIndex)}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-sm font-medium text-muted-foreground mb-1">
                  Next Unfinalized Queue Index
                </p>
                <p className="text-sm font-mono">
                  {formatBigint(derivedState?.query.nextUnfinalizedQueueIndex)}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-sm font-medium text-muted-foreground mb-1">
                  Locked NIGHT
                </p>
                <p className="text-sm font-mono">
                  {formatBigint(derivedState?.query.lockedNIGHT)}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-sm font-medium text-muted-foreground mb-1">
                  Fee Vault
                </p>
                <p className="text-sm font-mono">
                  {formatBigint(derivedState?.query.feeVault)}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-sm font-medium text-muted-foreground mb-1">
                  Pending Withdrawal (wallet)
                </p>
                <p className="text-sm font-mono">
                  {formatBigint(derivedState?.query.pendingWithdrawal)}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Withdrawal Queue</CardTitle>
              <CardDescription>Root and message count</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-sm font-medium text-muted-foreground mb-1">
                  Withdraw Root
                </p>
                <p
                  className="text-sm font-mono break-all"
                  title={formatBytes(derivedState?.query.withdrawRoot)}
                >
                  {truncateMiddle(formatBytes(derivedState?.query.withdrawRoot))}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-sm font-medium text-muted-foreground mb-1">
                  Withdraw Message Count
                </p>
                <p className="text-sm font-mono">
                  {formatBigint(derivedState?.query.withdrawMessageCount)}
                </p>
              </div>
              <Button
                onClick={refreshQueries}
                disabled={!deployedContractAPI}
                variant={deployedContractAPI ? "default" : "secondary"}
                className="gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                Refresh Queries
              </Button>
            </CardContent>
          </Card>
        </div>

        {actionMessages.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/30 p-4">
            <p className="text-sm font-medium text-muted-foreground mb-2">
              Activity
            </p>
            <div className="space-y-1">
              {actionMessages.map((item) => (
                <p key={item.key} className="text-sm text-foreground">
                  {item.value}
                </p>
              ))}
            </div>
          </div>
        )}

        {actionError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{actionError}</p>
          </div>
        )}

        {providers?.flowMessage && (
          <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
            <p className="text-sm font-medium text-blue-600 dark:text-blue-400">
              {providers.flowMessage}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
