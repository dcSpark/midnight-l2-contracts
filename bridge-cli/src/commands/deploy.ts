/**
 * deploy command: deploy the Bridge contract. Uses network from -n/--network (or MIDNIGHT_NETWORK).
 * Wallet: --deployer-seed <hex> or FUNDING_SEED / MY_PREVIEW_MNEMONIC from env.
 */
import path from 'node:path';
import * as api from '../api.js';
import { hexToBytes32 } from '../batch-helpers.js';
import { type DeployCliConfig, getWalletSeedFromEnv } from '../cli-config.js';
import { createLogger } from '../logger.js';
import { currentDir } from '../config.js';
import type { ExecutorContext } from '../executor-context.js';

const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT8 = 255n;

export interface DeployOptions {
  /** Optional hex seed for deployer wallet (overrides env). */
  deployerSeed?: string;
  /** Optional constructor owner Bytes<32>. */
  owner?: string | Uint8Array;
  /** Optional initialize layer2ChainId Uint<64>. */
  layer2ChainId?: string | number | bigint;
  /** Optional initialize rollupId Bytes<32>. */
  rollupId?: string | Uint8Array;
  /** Optional initialize genesisStateRoot Bytes<32>. */
  genesisStateRoot?: string | Uint8Array;
  /** Optional initialize genesisBatchHash Bytes<32>. */
  genesisBatchHash?: string | Uint8Array;
  /** Optional initialize verifierSet Vector<3, NativePoint> as JSON or object. */
  verifierSet?: string | unknown;
  /** Optional initialize signatureThreshold Uint<8>. */
  signatureThreshold?: string | number | bigint;
  /** Optional initialize initialSequencer Bytes<32>. */
  initialSequencer?: string | Uint8Array;
  /** Optional initialize initialFinalizer Bytes<32>. */
  initialFinalizer?: string | Uint8Array;
  /** Machine-readable output. */
  json?: boolean;
}

export interface DeployResult {
  contractAddress: string;
  networkLabel: string;
  initializeTxHash?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const parseNonNegativeBigInt = (value: unknown, field: string): bigint => {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new Error(`${field} must be non-negative`);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative integer`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error(`${field} must not be empty`);
    }
    const n = BigInt(trimmed);
    if (n < 0n) {
      throw new Error(`${field} must be non-negative`);
    }
    return n;
  }
  throw new Error(`${field} must be bigint, number, or numeric string`);
};

const parseBoundedBigInt = (value: unknown, field: string, max: bigint): bigint => {
  const n = parseNonNegativeBigInt(value, field);
  if (n > max) {
    throw new Error(`${field} must be <= ${max.toString()}`);
  }
  return n;
};

const parseBytes32Input = (value: string | Uint8Array | undefined, field: string): Uint8Array | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value instanceof Uint8Array) {
    if (value.length !== 32) {
      throw new Error(`${field} must be 32 bytes`);
    }
    return value;
  }
  if (typeof value === 'string') {
    return hexToBytes32(value);
  }
  throw new Error(`${field} must be a 32-byte hex string`);
};

const parsePoint = (value: unknown, field: string): { x: bigint; y: bigint } => {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`${field} must be an object { x, y }`);
  }
  return {
    x: parseNonNegativeBigInt(value.x, `${field}.x`),
    y: parseNonNegativeBigInt(value.y, `${field}.y`),
  };
};

const parseVerifierSet = (value: string | unknown): { x: bigint; y: bigint }[] => {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.length !== 3) {
    throw new Error('verifierSet must be an array of exactly 3 points');
  }
  return parsed.map((point, index) => parsePoint(point, `verifierSet[${index}]`));
};

export const resolveConstructorOverrides = (opts: DeployOptions): api.BridgeConstructorArgOverrides | undefined => {
  const overrides: api.BridgeConstructorArgOverrides = {};
  let hasAny = false;
  const setOverride = <K extends keyof api.BridgeConstructorArgOverrides>(
    key: K,
    value: api.BridgeConstructorArgOverrides[K] | undefined,
  ) => {
    if (value === undefined) {
      return;
    }
    overrides[key] = value;
    hasAny = true;
  };

  setOverride('owner', parseBytes32Input(opts.owner, 'owner'));
  setOverride('layer2ChainId', opts.layer2ChainId !== undefined ? parseBoundedBigInt(opts.layer2ChainId, 'layer2ChainId', MAX_UINT64) : undefined);
  setOverride('rollupId', parseBytes32Input(opts.rollupId, 'rollupId'));
  setOverride('genesisStateRoot', parseBytes32Input(opts.genesisStateRoot, 'genesisStateRoot'));
  setOverride('genesisBatchHash', parseBytes32Input(opts.genesisBatchHash, 'genesisBatchHash'));
  setOverride('verifierSet', opts.verifierSet !== undefined ? parseVerifierSet(opts.verifierSet) : undefined);
  setOverride(
    'signatureThreshold',
    opts.signatureThreshold !== undefined
      ? parseBoundedBigInt(opts.signatureThreshold, 'signatureThreshold', MAX_UINT8)
      : undefined,
  );
  setOverride('initialSequencer', parseBytes32Input(opts.initialSequencer, 'initialSequencer'));
  setOverride('initialFinalizer', parseBytes32Input(opts.initialFinalizer, 'initialFinalizer'));

  return hasAny ? overrides : undefined;
};

export async function runDeploy(
  deployConfig: DeployCliConfig,
  opts: DeployOptions = {},
  executorContext?: ExecutorContext,
): Promise<DeployResult> {
  const { config, networkLabel } = deployConfig;

  let walletContext: api.WalletContext | null = null;
  let providers = executorContext?.providers;

  if (!providers) {
    const logPath = path.resolve(
      currentDir,
      '..',
      'logs',
      'bridge-cli',
      `${new Date().toISOString()}.log`,
    );
    const logger = await createLogger(logPath);
    api.setLogger(logger);
    logger.info(`Deploying bridge contract on ${networkLabel}...`);
    const walletSeed = opts.deployerSeed?.trim() ?? getWalletSeedFromEnv();
    const isHex =
      /^[0-9a-fA-F]{64}$/.test(walletSeed) ||
      /^0x[0-9a-fA-F]+$/.test(walletSeed);
    if (isHex) {
      const hex = walletSeed.replace(/^0x/, '');
      walletContext = await api.buildWalletFromHexSeed(config, hex);
    } else {
      walletContext = await api.buildWalletAndWaitForFunds(config, walletSeed);
    }
    providers = await api.configureProviders(walletContext, config);
  }

  try {
    const constructorOverrides = resolveConstructorOverrides(opts);
    const constructorArgs = api.resolveBridgeConstructorArgs(providers, constructorOverrides);
    const initializeArgs = api.resolveBridgeInitializeArgs(providers, constructorOverrides);
    const deployed = await api.deploy(providers, { privateState: 0 }, constructorArgs);
    const initializeTx = await ((deployed.callTx as unknown) as { initialize: (...args: unknown[]) => Promise<{ public: { txHash: string } }> }).initialize(
      ...initializeArgs,
    );
    const address = deployed.deployTxData.public.contractAddress;
    const result: DeployResult = {
      contractAddress: address,
      networkLabel,
      initializeTxHash: initializeTx.public.txHash,
    };
    if (!executorContext) {
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        process.stdout.write(`BRIDGE_ADDRESS=${address}\n`);
        process.stdout.write(`VITE_CONTRACT_ADDRESS="${address}"\n`);
        process.stdout.write(`BRIDGE_INITIALIZE_TX_HASH=${initializeTx.public.txHash}\n`);
      }
    }
    return result;
  } finally {
    if (walletContext) {
      await api.closeWallet(walletContext);
    }
  }
}
