import { type Logger } from "pino";
import {
  type ContractAddress,
  encodeCoinPublicKey,
} from "@midnight-ntwrk/compact-runtime";
import * as Rx from "rxjs";
import {
  defaultPrivateState,
  emptyQueryState,
  emptyState,
  BridgePrivateStateId,
} from "./common-types";
import type {
  BridgeContract,
  BridgeProviders,
  DeployedBridgeContract,
  DerivedState,
  QueryState,
  UserAction,
} from "./common-types";
import {
  Bridge,
  type BridgePrivateState,
  witnesses,
} from "bridge-contract/browser";
import {
  call,
  deployContract,
  findDeployedContract,
  getPublicStates,
} from "@midnight-ntwrk/midnight-js-contracts";
import { PrivateStateProvider } from "@midnight-ntwrk/midnight-js-types";
import * as ledger from "@midnight-ntwrk/ledger-v7";

export const DEFAULT_VERIFIER_SECRET_KEYS = [101n, 102n, 103n];
export const DEFAULT_SIGNATURE_THRESHOLD = 1n;
export const DEFAULT_LAYER2_CHAIN_ID = 0n;
const ZERO_BYTES_32 = new Uint8Array(32);

type BridgeConstructorArgs = [
  Uint8Array,
];

type BridgeInitializeArgs = [
  bigint,
  Uint8Array,
  Uint8Array,
  Uint8Array,
  { x: bigint; y: bigint }[],
  bigint,
  Uint8Array,
  Uint8Array,
];

const createDefaultConstructorArgs = (
  ownerBytes: Uint8Array
): BridgeConstructorArgs => {
  return [ownerBytes];
};

const createDefaultInitializeArgs = (
  ownerBytes: Uint8Array
): BridgeInitializeArgs => {
  const verifierSet = DEFAULT_VERIFIER_SECRET_KEYS.map((sk) =>
    Bridge.pureCircuits.derivePk(sk)
  );
  return [
    DEFAULT_LAYER2_CHAIN_ID,
    ZERO_BYTES_32,
    ZERO_BYTES_32,
    ZERO_BYTES_32,
    verifierSet,
    DEFAULT_SIGNATURE_THRESHOLD,
    ownerBytes,
    ZERO_BYTES_32,
  ];
};

export const bridgeContractInstance: BridgeContract = new Bridge.Contract(
  witnesses
);

export interface ContractControllerInterface {
  readonly deployedContractAddress: ContractAddress;
  readonly state$: Rx.Observable<DerivedState>;
  refreshQueries: () => Promise<void>;
  depositNIGHT: (
    amount: bigint,
    l2Recipient: Uint8Array,
    gasLimit: bigint,
    timestamp: bigint
  ) => Promise<Bridge.L1_DepositResult>;
  depositNIGHTUnshielded: (
    amount: bigint,
    l2Recipient: Uint8Array,
    gasLimit: bigint,
    timestamp: bigint
  ) => Promise<Bridge.L1_DepositResult>;
  withdrawNIGHT: (
    recipient: Uint8Array,
    amount: bigint
  ) => Promise<Bridge.WithdrawNIGHTResult>;
  claimL1WithdrawalUnshielded: (
    recipient: Uint8Array,
    amount: bigint
  ) => Promise<void>;
}

export class ContractController implements ContractControllerInterface {
  readonly deployedContractAddress: ContractAddress;
  readonly state$: Rx.Observable<DerivedState>;
  readonly queryState$: Rx.BehaviorSubject<QueryState>;
  readonly turns$: Rx.BehaviorSubject<UserAction>;

  private constructor(
    public readonly contractPrivateStateId: typeof BridgePrivateStateId,
    public readonly deployedContract: DeployedBridgeContract,
    public readonly providers: BridgeProviders
  ) {
    this.deployedContractAddress =
      deployedContract.deployTxData.public.contractAddress;
    this.turns$ = new Rx.BehaviorSubject<UserAction>(emptyState.turns);
    this.queryState$ = new Rx.BehaviorSubject<QueryState>(emptyQueryState);

    this.state$ = Rx.combineLatest(
      [this.queryState$, this.turns$],
      (queryState, userActions) => {
        return {
          query: queryState,
          turns: userActions,
        } satisfies DerivedState;
      }
    ).pipe(
      Rx.retry({
        delay: 500,
      })
    );
  }

  async refreshQueries(): Promise<void> {
    this.updateTurns({ refresh: "Refreshing contract data" });
    try {
      if (!this.providers.publicDataProvider || !this.providers.walletProvider) {
        throw new Error("Providers are not available");
      }
      const publicStates = await getPublicStates(
        this.providers.publicDataProvider,
        this.deployedContractAddress
      );
      const coinPublicKey = this.providers.walletProvider.getCoinPublicKey();
      if (!coinPublicKey) {
        throw new Error("Wallet provider is not available");
      }
      const initialPrivateState = await ContractController.getPrivateState(
        this.contractPrivateStateId,
        this.providers.privateStateProvider
      );
      const baseOptions = {
        contract: bridgeContractInstance,
        contractAddress: this.deployedContractAddress,
        coinPublicKey,
        initialContractState: publicStates.contractState,
        initialZswapChainState: publicStates.zswapChainState,
        initialPrivateState,
      };

      const nextCrossDomainMessageIndex = call({
        ...baseOptions,
        circuitId: "getNextCrossDomainMessageIndex",
      });
      const nextUnfinalizedQueueIndex = call({
        ...baseOptions,
        circuitId: "getNextUnfinalizedQueueIndex",
      });
      const lockedNIGHT = call({
        ...baseOptions,
        circuitId: "getLockedNIGHT",
      });
      const feeVault = call({
        ...baseOptions,
        circuitId: "getFeeVault",
      });
      const withdrawRoot = call({
        ...baseOptions,
        circuitId: "getWithdrawRoot",
      });
      const withdrawMessageCount = call({
        ...baseOptions,
        circuitId: "getWithdrawMessageCount",
      });

      const recipientBytes = encodeCoinPublicKey(coinPublicKey);
      const pendingWithdrawal = call({
        ...baseOptions,
        circuitId: "getPendingWithdrawal",
        args: [recipientBytes],
      });

      this.updateQuery({
        nextCrossDomainMessageIndex: nextCrossDomainMessageIndex.private.result,
        nextUnfinalizedQueueIndex: nextUnfinalizedQueueIndex.private.result,
        lockedNIGHT: lockedNIGHT.private.result,
        feeVault: feeVault.private.result,
        withdrawRoot: withdrawRoot.private.result,
        withdrawMessageCount: withdrawMessageCount.private.result,
        pendingWithdrawal: pendingWithdrawal.private.result,
      });
    } finally {
      this.updateTurns({ refresh: undefined });
    }
  }

  async depositNIGHT(
    amount: bigint,
    l2Recipient: Uint8Array,
    gasLimit: bigint,
    timestamp: bigint
  ): Promise<Bridge.L1_DepositResult> {
    this.updateTurns({ depositNIGHT: "Submitting depositNIGHT" });
    try {
      const coin = ledger.createShieldedCoinInfo(
        ledger.nativeToken().raw,
        amount
      );
      const encodedCoin = ledger.encodeShieldedCoinInfo(coin);
      const txData = await this.deployedContract.callTx.depositNIGHT(
        encodedCoin,
        l2Recipient,
        gasLimit,
        timestamp
      );
      const result = txData.private.result;
      this.updateQuery({ lastDeposit: result });
      await this.refreshQueries();
      return result;
    } finally {
      this.updateTurns({ depositNIGHT: undefined });
    }
  }

  async depositNIGHTUnshielded(
    amount: bigint,
    l2Recipient: Uint8Array,
    gasLimit: bigint,
    timestamp: bigint
  ): Promise<Bridge.L1_DepositResult> {
    this.updateTurns({
      depositNIGHTUnshielded: "Submitting unshielded deposit",
    });
    try {
      const txData = await this.deployedContract.callTx.depositNIGHTUnshielded(
        amount,
        l2Recipient,
        gasLimit,
        timestamp
      );
      console.info(
        "[bridge] depositNIGHTUnshielded txHash",
        txData.public.txHash
      );
      const result = txData.private.result;
      this.updateQuery({ lastDeposit: result });
      await this.refreshQueries();
      return result;
    } catch (error) {
      console.error("[bridge] depositNIGHTUnshielded error", error);
      throw error;
    } finally {
      this.updateTurns({ depositNIGHTUnshielded: undefined });
    }
  }

  async withdrawNIGHT(
    recipient: Uint8Array,
    amount: bigint
  ): Promise<Bridge.WithdrawNIGHTResult> {
    this.updateTurns({ withdrawNIGHT: "Submitting withdrawNIGHT" });
    try {
      const txData = await this.deployedContract.callTx.withdrawNIGHT(
        recipient,
        amount
      );
      const result = txData.private.result;
      this.updateQuery({ lastWithdraw: result });
      await this.refreshQueries();
      return result;
    } finally {
      this.updateTurns({ withdrawNIGHT: undefined });
    }
  }

  async claimL1WithdrawalUnshielded(
    recipient: Uint8Array,
    amount: bigint
  ): Promise<void> {
    this.updateTurns({
      claimL1WithdrawalUnshielded: "Claiming unshielded withdrawal",
    });
    try {
      await this.deployedContract.callTx.claimL1WithdrawalUnshielded(
        recipient,
        amount
      );
      await this.refreshQueries();
    } finally {
      this.updateTurns({ claimL1WithdrawalUnshielded: undefined });
    }
  }

  private updateTurns(partial: Partial<UserAction>): void {
    this.turns$.next({ ...this.turns$.value, ...partial });
  }

  private updateQuery(partial: Partial<QueryState>): void {
    this.queryState$.next({ ...this.queryState$.value, ...partial });
  }

  static async deploy(
    contractPrivateStateId: typeof BridgePrivateStateId,
    providers: BridgeProviders,
    logger: Logger
  ): Promise<ContractController> {
    const ownerBytes = ContractController.getOwnerBytes(providers);
    logger.info({
      deployContract: {
        action: "Deploying bridge contract",
        contractPrivateStateId,
        providers,
      },
    });
    const deployedContract = await deployContract(providers, {
      privateStateId: contractPrivateStateId,
      contract: bridgeContractInstance,
      initialPrivateState: await ContractController.getPrivateState(
        contractPrivateStateId,
        providers.privateStateProvider
      ),
      args: createDefaultConstructorArgs(ownerBytes),
    });
    await (
      (deployedContract.callTx as unknown) as {
        initialize: (...args: unknown[]) => Promise<unknown>;
      }
    ).initialize(...createDefaultInitializeArgs(ownerBytes));

    logger.trace({
      contractDeployed: {
        action: "Contract was deployed",
        contractPrivateStateId,
        finalizedDeployTxData: deployedContract.deployTxData.public,
      },
    });

    const controller = new ContractController(
      contractPrivateStateId,
      deployedContract,
      providers
    );
    await controller.refreshQueries();
    return controller;
  }

  static async join(
    contractPrivateStateId: typeof BridgePrivateStateId,
    providers: BridgeProviders,
    contractAddress: ContractAddress,
    logger: Logger
  ): Promise<ContractController> {
    logger.info({
      joinContract: {
        action: "Joining contract",
        contractPrivateStateId,
        contractAddress,
      },
    });

    const deployedContract = await findDeployedContract(providers, {
      contractAddress,
      contract: bridgeContractInstance,
      privateStateId: contractPrivateStateId,
      initialPrivateState: await ContractController.getPrivateState(
        contractPrivateStateId,
        providers.privateStateProvider
      ),
    });

    logger.trace({
      contractJoined: {
        action: "Join the contract successfully",
        contractPrivateStateId,
        finalizedDeployTxData: deployedContract.deployTxData.public,
      },
    });

    const controller = new ContractController(
      contractPrivateStateId,
      deployedContract,
      providers
    );
    await controller.refreshQueries();
    return controller;
  }

  private static getOwnerBytes(providers: BridgeProviders): Uint8Array {
    if (!providers.walletProvider) {
      throw new Error("Wallet provider is not available");
    }
    const coinPublicKey = providers.walletProvider.getCoinPublicKey();
    if (!coinPublicKey) {
      throw new Error("Wallet coin public key is not available");
    }
    return encodeCoinPublicKey(coinPublicKey);
  }

  private static async getPrivateState(
    bridgePrivateStateId: typeof BridgePrivateStateId,
    privateStateProvider: PrivateStateProvider<
      typeof BridgePrivateStateId,
      BridgePrivateState
    >
  ): Promise<BridgePrivateState> {
    const existingPrivateState = await privateStateProvider.get(
      bridgePrivateStateId
    );
    if (existingPrivateState != null) {
      return existingPrivateState;
    }
    await privateStateProvider.set(bridgePrivateStateId, defaultPrivateState);
    return defaultPrivateState;
  }
}
