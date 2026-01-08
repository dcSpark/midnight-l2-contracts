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
import { useWallet } from "@/modules/midnight/wallet-widget/hooks/useWallet";
import {
  encodeCoinPublicKey,
  fromHex,
  toHex,
} from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnight-ntwrk/ledger-v6";
import { bech32, bech32m } from "@scure/base";
import {
  MidnightBech32m,
  UnshieldedAddress,
} from "@midnight-ntwrk/wallet-sdk-address-format";

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

const formatWalletBalance = (value?: bigint) => {
  if (value === undefined) {
    return "Not connected";
  }
  return value.toString();
};

const getTokenBalance = (
  balances: Record<string, bigint> | undefined,
  tokenId: string
) => {
  if (!balances) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(balances, tokenId)) {
    return balances[tokenId];
  }
  return 0n;
};

const padBytes32 = (label: string, bytes: Uint8Array) => {
  if (bytes.length > 32) {
    throw new Error(`${label} must be 32 bytes or less`);
  }
  if (bytes.length === 32) {
    return bytes;
  }
  const padded = new Uint8Array(32);
  padded.set(bytes, 32 - bytes.length);
  return padded;
};

const decodeBech32Bytes = (label: string, value: string) => {
  const trimmed = value.trim();
  const decoders = [bech32m, bech32];
  let lastError: Error | undefined;
  for (const decoder of decoders) {
    try {
      const { words } = decoder.decode(trimmed);
      return padBytes32(label, Uint8Array.from(decoder.fromWords(words)));
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw (
    lastError ?? new Error(`${label} must be hex or a bech32 address`)
  );
};

const parseBytes32 = (label: string, value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  const normalized = trimmed.replace(/^0x/i, "");
  if (/^[0-9a-fA-F]+$/.test(normalized)) {
    if (normalized.length > 64) {
      throw new Error(`${label} must be 32 bytes or less`);
    }
    return fromHex(normalized.padStart(64, "0"));
  }
  try {
    return decodeBech32Bytes(label, trimmed);
  } catch {
    throw new Error(`${label} must be hex or a bech32 address`);
  }
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
  const {
    unshieldedAddress,
    unshieldedBalances,
    shieldedBalances,
    dustBalance,
    refresh: refreshWallet,
    status,
  } = useWallet();
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
  const [unshieldedDepositAmountInput, setUnshieldedDepositAmountInput] =
    useState<string>("0");
  const [unshieldedDepositRecipientInput, setUnshieldedDepositRecipientInput] =
    useState<string>("");
  const [unshieldedDepositGasLimitInput, setUnshieldedDepositGasLimitInput] =
    useState<string>("100000");
  const [unshieldedDepositTimestampInput, setUnshieldedDepositTimestampInput] =
    useState<string>(nowSeconds());
  const [unshieldedClaimRecipientInput, setUnshieldedClaimRecipientInput] =
    useState<string>("");
  const [unshieldedClaimAmountInput, setUnshieldedClaimAmountInput] =
    useState<string>("0");

  useEffect(() => {
    if (derivedState) {
      setAppLoading(false);
    }
  }, [derivedState]);

  const connectedAddress = deployedContractAPI?.deployedContractAddress;
  const nightTokenId = useMemo(() => ledger.nativeToken().raw, []);
  const unshieldedNightBalance = useMemo(
    () => getTokenBalance(unshieldedBalances, nightTokenId),
    [unshieldedBalances, nightTokenId]
  );
  const shieldedNightBalance = useMemo(
    () => getTokenBalance(shieldedBalances, nightTokenId),
    [shieldedBalances, nightTokenId]
  );

  const walletRecipientHex = useMemo(() => {
    const coinPublicKey = providers?.walletProvider?.getCoinPublicKey();
    if (!coinPublicKey) {
      return undefined;
    }
    return toHex(encodeCoinPublicKey(coinPublicKey));
  }, [providers?.walletProvider]);
  const walletUnshieldedHex = useMemo(() => {
    if (!unshieldedAddress?.unshieldedAddress) {
      return undefined;
    }
    try {
      const parsed = MidnightBech32m.parse(unshieldedAddress.unshieldedAddress);
      const decoded = UnshieldedAddress.codec.decode(parsed.network, parsed);
      return decoded.hexString;
    } catch (error) {
      return undefined;
    }
  }, [unshieldedAddress?.unshieldedAddress]);

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

  const submitUnshieldedDeposit = async () => {
    if (!deployedContractAPI) {
      return;
    }
    setActionError(undefined);
    try {
      const amount = parseBigint(
        "Unshielded deposit amount",
        unshieldedDepositAmountInput
      ) * 10n ** 6n;
      if (amount <= 0n) {
        throw new Error("Deposit amount must be greater than zero");
      }
      const recipientHex =
        unshieldedDepositRecipientInput.trim() || walletRecipientHex || "";
      const l2Recipient = parseBytes32("L2 recipient", recipientHex);
      const gasLimit = parseBigint("Gas limit", unshieldedDepositGasLimitInput);
      const timestamp = parseBigint(
        "Timestamp",
        unshieldedDepositTimestampInput || nowSeconds()
      );
      await deployedContractAPI.depositNIGHTUnshielded(
        amount,
        l2Recipient,
        gasLimit,
        timestamp
      );
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Failed to deposit unshielded NIGHT"
      );
    }
  };

  const submitUnshieldedClaim = async () => {
    if (!deployedContractAPI) {
      return;
    }
    setActionError(undefined);
    try {
      const recipientHex =
        unshieldedClaimRecipientInput.trim() || walletUnshieldedHex || "";
      const recipient = parseBytes32("Recipient", recipientHex);
      const amount = parseBigint("Amount", unshieldedClaimAmountInput);
      if (amount <= 0n) {
        throw new Error("Amount must be greater than zero");
      }
      await deployedContractAPI.claimL1WithdrawalUnshielded(recipient, amount);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Failed to claim unshielded withdrawal"
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
              <CardTitle>Wallet Balances</CardTitle>
              <CardDescription>Unshielded and shielded NIGHT</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-sm font-medium text-muted-foreground mb-1">
                  Unshielded NIGHT
                </p>
                <p className="text-sm font-mono">
                  {formatWalletBalance(unshieldedNightBalance)}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-sm font-medium text-muted-foreground mb-1">
                  Shielded NIGHT
                </p>
                <p className="text-sm font-mono">
                  {formatWalletBalance(shieldedNightBalance)}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-sm font-medium text-muted-foreground mb-1">
                  Dust Balance
                </p>
                <p className="text-sm font-mono">
                  {formatWalletBalance(dustBalance?.balance)}
                </p>
              </div>
              <Button
                onClick={refreshWallet}
                disabled={status?.status !== "connected"}
                variant={status?.status === "connected" ? "default" : "secondary"}
                className="gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                Refresh Wallet
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Bridge Balances</CardTitle>
              <CardDescription>Liquidity held by the bridge</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-sm font-medium text-muted-foreground mb-1">
                  Locked NIGHT (getLockedNIGHT)
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
        </div>

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
                  placeholder="L2 recipient (hex or bech32)"
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
                  placeholder="Recipient (hex or bech32)"
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

        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-foreground">
              Unshielded NIGHT
            </h2>
            <p className="text-sm text-muted-foreground">
              Use unshielded balances for L1 deposits and withdrawal claims
            </p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Unshielded Deposit to L2</CardTitle>
                <CardDescription>
                  Send unshielded NIGHT into the cross-domain queue
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 gap-3">
                  <input
                    value={unshieldedDepositAmountInput}
                    onChange={(event) =>
                      setUnshieldedDepositAmountInput(event.target.value)
                    }
                    placeholder="Amount (bigint)"
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  />
                  <input
                    value={unshieldedDepositRecipientInput}
                    onChange={(event) =>
                      setUnshieldedDepositRecipientInput(event.target.value)
                    }
                    placeholder="L2 recipient (hex or bech32)"
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        walletRecipientHex &&
                        setUnshieldedDepositRecipientInput(walletRecipientHex)
                      }
                      disabled={!walletRecipientHex}
                    >
                      Use wallet recipient
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        setUnshieldedDepositTimestampInput(nowSeconds())
                      }
                    >
                      Use current time
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <input
                      value={unshieldedDepositGasLimitInput}
                      onChange={(event) =>
                        setUnshieldedDepositGasLimitInput(event.target.value)
                      }
                      placeholder="Gas limit"
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    />
                    <input
                      value={unshieldedDepositTimestampInput}
                      onChange={(event) =>
                        setUnshieldedDepositTimestampInput(event.target.value)
                      }
                      placeholder="Timestamp (unix seconds)"
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Uses unshielded NIGHT balance in your wallet.
                </p>
                <Button
                  onClick={submitUnshieldedDeposit}
                  disabled={!deployedContractAPI}
                  variant={deployedContractAPI ? "default" : "secondary"}
                >
                  Submit depositNIGHTUnshielded
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Claim Unshielded Withdrawal</CardTitle>
                <CardDescription>
                  Claim a verified withdrawal to an L1 recipient
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 gap-3">
                  <input
                    value={unshieldedClaimRecipientInput}
                    onChange={(event) =>
                      setUnshieldedClaimRecipientInput(event.target.value)
                    }
                    placeholder="Recipient (hex or bech32)"
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  />
                  <input
                    value={unshieldedClaimAmountInput}
                    onChange={(event) =>
                      setUnshieldedClaimAmountInput(event.target.value)
                    }
                    placeholder="Amount (bigint)"
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      walletUnshieldedHex &&
                      setUnshieldedClaimRecipientInput(walletUnshieldedHex)
                    }
                    disabled={!walletUnshieldedHex}
                  >
                    Use wallet unshielded address
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Requires a pending withdrawal proof to be relayed.
                </p>
                <Button
                  onClick={submitUnshieldedClaim}
                  disabled={!deployedContractAPI}
                  variant={deployedContractAPI ? "default" : "secondary"}
                >
                  Submit claimL1WithdrawalUnshielded
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Rollup State</CardTitle>
              <CardDescription>Queue pointers</CardDescription>
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
