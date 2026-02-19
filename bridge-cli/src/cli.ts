/**
 * Non-interactive Bridge CLI entrypoint. All arguments via argv and env.
 * For interactive TUI use run() from this module (exported from cli-interactive).
 */
import 'dotenv/config';
import { Command } from 'commander';
import { WebSocket } from 'ws';
import { resolveCliConfig } from './cli-config.js';
import { resolveDeployConfig } from './cli-config.js';
import {
  runState,
  runDeploy,
  runCommitBatch,
  runFinalizeBatch,
  runFinalizeBatchFromLedger,
  runSetVerifierSet,
  runClaimL1WithdrawalUnshielded,
} from './commands/index.js';
import {
  parseBatchPublicDataFromJson,
  parseSignaturesFromJson,
} from './batch-helpers.js';

// Required for Midnight indexer/sdk in Node
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

export { run } from './cli-interactive.js';

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('bridge-cli')
    .description('Bridge contract CLI (non-interactive). Use env vars or flags for config.')
    .option('-c, --contract <address>', 'Bridge contract address (or BRIDGE_CONTRACT_ADDRESS)')
    .option('--indexer <url>', 'Indexer HTTP URL (or INDEXER_HTTP)')
    .option('--indexer-ws <url>', 'Indexer WebSocket URL (or INDEXER_WS)')
    .option('--node <url>', 'Midnight node WS URL (or MIDNIGHT_NODE_WS / NODE_WS)')
    .option('--proof-server <url>', 'Proof server URL (or PROOF_SERVER)')
    .option('-n, --network <name>', 'Network: preview | undeployed (or MIDNIGHT_NETWORK)')
    .option('--json', 'Output JSON');

  program
    .command('deploy')
    .description(
      'Deploy the Bridge contract. Network via -n/--network (or MIDNIGHT_NETWORK). Wallet: --deployer-seed <hex> or FUNDING_SEED / MY_PREVIEW_MNEMONIC.',
    )
    .option('--deployer-seed <hex>', 'Deployer wallet hex seed (32 bytes, 64 hex chars). Overrides env.')
    .action(async (subOpts: { deployerSeed?: string }) => {
      const opts = program.opts();
      const deployConfig = resolveDeployConfig({
        indexer: opts.indexer,
        indexerWS: opts.indexerWs,
        node: opts.node,
        proofServer: opts.proofServer,
        network: opts.network,
      });
      await runDeploy(deployConfig, {
        deployerSeed: subOpts.deployerSeed,
        json: opts.json,
      });
    });

  program
    .command('state')
    .description('Read and print Bridge state (no wallet required)')
    .action(async () => {
      const opts = program.opts();
      const cliConfig = resolveCliConfig({
        contract: opts.contract,
        indexer: opts.indexer,
        indexerWS: opts.indexerWs,
        node: opts.node,
        proofServer: opts.proofServer,
        network: opts.network,
      });
      await runState(cliConfig, { json: opts.json });
    });

  program
    .command('commit-batch')
    .description(
      'Commit a batch (rollup node). Requires --parent-hash and --batch-hash. Requires FUNDING_SEED or MY_PREVIEW_MNEMONIC.',
    )
    .requiredOption('--parent-hash <hex>', 'Parent batch hash (32 bytes, 64 hex chars)')
    .requiredOption('--batch-hash <hex>', 'New batch hash (32 bytes, 64 hex chars)')
    .action(async (subOpts: { parentHash: string; batchHash: string }) => {
      const opts = program.opts();
      const cliConfig = resolveCliConfig({
        contract: opts.contract,
        indexer: opts.indexer,
        indexerWS: opts.indexerWs,
        node: opts.node,
        proofServer: opts.proofServer,
        network: opts.network,
      });
      await runCommitBatch(cliConfig, {
        parentHash: subOpts.parentHash,
        batchHash: subOpts.batchHash,
        json: opts.json,
      });
    });

  program
    .command('finalize-batch')
    .description(
      'Finalize a batch. Requires the four finalizeBatch arguments: --batch-public-data (JSON), --signatures (JSON), --signer-bitmap, --finalize-timestamp. Wallet required (env).',
    )
    .requiredOption(
      '--batch-public-data <json>',
      'BatchPublicDataV1Full as JSON (Bytes<32> as 64-char hex, numbers as strings)',
    )
    .requiredOption(
      '--signatures <json>',
      'Array of 3 Signature as JSON: [{ pk: {x,y}, r: {x,y}, s }, ...]',
    )
    .requiredOption('--signer-bitmap <n>', 'Signer bitmap (Uint<8>, decimal)')
    .requiredOption('--finalize-timestamp <n>', 'Finalize timestamp (Uint<64>, decimal)')
    .action(
      async (subOpts: {
        batchPublicData: string;
        signatures: string;
        signerBitmap: string;
        finalizeTimestamp: string;
      }) => {
        const opts = program.opts();
        const cliConfig = resolveCliConfig({
          contract: opts.contract,
          indexer: opts.indexer,
          indexerWS: opts.indexerWs,
          node: opts.node,
          proofServer: opts.proofServer,
          network: opts.network,
        });
        const batchPublicData = parseBatchPublicDataFromJson(subOpts.batchPublicData);
        const signatures = parseSignaturesFromJson(subOpts.signatures);
        const signerBitmap = BigInt(subOpts.signerBitmap);
        const finalizeTimestamp = BigInt(subOpts.finalizeTimestamp);
        await runFinalizeBatch(cliConfig, {
          batchPublicData,
          signatures,
          signerBitmap,
          finalizeTimestamp,
          json: opts.json,
        });
      },
    );

  program
    .command('finalize-batch-from-ledger')
    .description(
      'Build finalizeBatch args from ledger (ensurePendingBatch, buildBatchPublicData, sign) and submit. Test/blueprint command; same logic can be implemented in Rust.',
    )
    .action(async () => {
      const opts = program.opts();
      const cliConfig = resolveCliConfig({
        contract: opts.contract,
        indexer: opts.indexer,
        indexerWS: opts.indexerWs,
        node: opts.node,
        proofServer: opts.proofServer,
        network: opts.network,
      });
      await runFinalizeBatchFromLedger(cliConfig, { json: opts.json });
    });

  program
    .command('set-verifier-set')
    .description('Set the Bridge verifier set (admin). Requires wallet.')
    .action(async () => {
      const opts = program.opts();
      const cliConfig = resolveCliConfig({
        contract: opts.contract,
        indexer: opts.indexer,
        indexerWS: opts.indexerWs,
        node: opts.node,
        proofServer: opts.proofServer,
        network: opts.network,
      });
      await runSetVerifierSet(cliConfig, { json: opts.json });
    });

  program
    .command('claim-l1-withdrawal-unshielded')
    .description('Claim L1 withdrawal (user). Requires wallet.')
    .requiredOption('--recipient <hex>', 'Recipient address (32 bytes, 64 hex chars)')
    .requiredOption('--amount <amount>', 'Amount (decimal string)')
    .action(async (subOpts: { recipient: string; amount: string }) => {
      const opts = program.opts();
      const cliConfig = resolveCliConfig({
        contract: opts.contract,
        indexer: opts.indexer,
        indexerWS: opts.indexerWs,
        node: opts.node,
        proofServer: opts.proofServer,
        network: opts.network,
      });
      await runClaimL1WithdrawalUnshielded(cliConfig, {
        recipient: subOpts.recipient,
        amount: subOpts.amount,
        json: opts.json,
      });
    });

  await program.parseAsync(process.argv);

  if (!process.argv.slice(2).length) {
    program.outputHelp();
    process.exitCode = 1;
  }
}

const isCliEntry =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('cli.js') || process.argv[1].endsWith('cli.ts'));
if (isCliEntry) {
  void main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
