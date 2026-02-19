/**
 * Resolves CLI config and contract address from environment (and optional overrides).
 * Used by all bridge-cli subcommands.
 */
import { assertIsContractAddress } from '@midnight-ntwrk/midnight-js-utils';
import { type Config, PreviewConfig, UndeployedConfig } from './config.js';

export type NetworkPreference = 'preview' | 'undeployed';

const NETWORK_MAP: Record<string, NetworkPreference> = {
  preview: 'preview',
  undeployed: 'undeployed',
  local: 'undeployed',
  standalone: 'undeployed',
  dev: 'undeployed',
};

export interface CliConfig {
  config: Config;
  contractAddress: string;
  networkLabel: string;
}

export function resolveCliConfig(opts?: {
  contract?: string;
  indexer?: string;
  indexerWS?: string;
  node?: string;
  proofServer?: string;
  network?: string;
}): CliConfig {
  const envPreference = (
    opts?.network ??
    process.env.MIDNIGHT_NETWORK ??
    process.env.MIDNIGHT_ENV ??
    ''
  )
    .trim()
    .toLowerCase();

  let config: Config;
  let networkLabel: string;

  if (envPreference.length === 0) {
    config = new PreviewConfig();
    networkLabel = 'preview (default)';
  } else {
    const preference = NETWORK_MAP[envPreference];
    if (preference === 'undeployed') {
      config = new UndeployedConfig();
      networkLabel = 'undeployed/local';
    } else if (preference === 'preview') {
      config = new PreviewConfig();
      networkLabel = 'preview';
    } else {
      config = new PreviewConfig();
      networkLabel = `preview (fallback for unknown "${envPreference}")`;
    }
  }

  const contractAddress =
    opts?.contract ??
    process.env.BRIDGE_CONTRACT_ADDRESS ??
    process.env.DEFAULT_BRIDGE_ADDRESS ??
    '';
  if (!contractAddress) {
    throw new Error(
      'Contract address required. Set BRIDGE_CONTRACT_ADDRESS or pass --contract',
    );
  }
  assertIsContractAddress(contractAddress);

  const c = config as Config & { indexer: string; indexerWS: string; node: string; proofServer: string };
  if (opts?.indexer) c.indexer = opts.indexer;
  else if (process.env.INDEXER_HTTP) c.indexer = process.env.INDEXER_HTTP;
  if (opts?.indexerWS) c.indexerWS = opts.indexerWS;
  else if (process.env.INDEXER_WS) c.indexerWS = process.env.INDEXER_WS;
  if (opts?.node) c.node = opts.node;
  else if (process.env.MIDNIGHT_NODE_WS) c.node = process.env.MIDNIGHT_NODE_WS;
  else if (process.env.NODE_WS) c.node = process.env.NODE_WS;
  if (opts?.proofServer) c.proofServer = opts.proofServer;
  else if (process.env.PROOF_SERVER) c.proofServer = process.env.PROOF_SERVER;

  return { config, contractAddress, networkLabel };
}

export function getWalletSeedFromEnv(): string {
  const hex = process.env.FUNDING_SEED ?? process.env.TEST_DECODE_WALLET_HEX_SEED;
  if (hex?.trim()) return hex.trim();
  const mnemonic = process.env.MY_PREVIEW_MNEMONIC;
  if (mnemonic?.trim()) return mnemonic.trim();
  return '0000000000000000000000000000000000000000000000000000000000000001';
}
