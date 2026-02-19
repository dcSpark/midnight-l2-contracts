/* eslint-env node */
/**
 * Dev/regression script: decode Bridge state and optionally run a dummy commit+finalize batch.
 * Reuses the same command logic as the CLI (state + finalize-batch).
 */
import 'dotenv/config';
import { WebSocket } from 'ws';
import { stderr, stdout } from 'node:process';
import { Console } from 'node:console';
import { resolveCliConfig } from './cli-config.js';
import { runState } from './commands/state.js';
import { runFinalizeBatchFromLedger } from './commands/finalize-batch.js';
import { UndeployedConfig } from './config.js';

const console = new Console({ stdout, stderr });
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

const DEFAULT_CONTRACT_ADDRESS =
  'fa8533250190a9d2b39686523e7b13e7dc30647a341f8163dceaec2cdc365f12';

async function main(): Promise<void> {
  globalThis.console = console;
  const cliConfig = resolveCliConfig({
    contract:
      process.env.BRIDGE_CONTRACT_ADDRESS ??
      process.env.DEFAULT_BRIDGE_ADDRESS ??
      DEFAULT_CONTRACT_ADDRESS,
  });
  await runState(cliConfig, { json: false });

  const skipFlag = (process.env.TEST_DECODE_SKIP_BATCH ?? '').trim().toLowerCase();
  if (skipFlag === '1' || skipFlag === 'true') {
    console.log('Skipping dummy batch submission because TEST_DECODE_SKIP_BATCH is set.');
    return;
  }
  if (!(cliConfig.config instanceof UndeployedConfig)) {
    console.log('Skipping dummy batch submission (only supported on undeployed/local networks).');
    return;
  }
  console.log('---');
  console.log('Running finalize-batch-from-ledger (build args from ledger, then submit)...');
  await runFinalizeBatchFromLedger(cliConfig, { json: false });
  console.log('Done.');
}

void main().catch((error) => {
  console.error('Failed:', error);
  process.exitCode = 1;
});
