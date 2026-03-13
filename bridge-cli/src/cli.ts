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
  runDeposit,
  runRelayWithdrawNightWithProof,
  runTestWithdraw,
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
    .option('--owner <hex>', 'Deploy owner Bytes<32> (64 hex chars). Default: deployer coin public key')
    .option('--layer2-chain-id <n>', 'Initialize layer2ChainId Uint<64> (decimal). Default: 0')
    .option('--rollup-id <hex>', 'Initialize rollupId Bytes<32> (64 hex chars). Default: 0x00..00')
    .option(
      '--genesis-state-root <hex>',
      'Initialize genesisStateRoot Bytes<32> (64 hex chars). Default: 0x00..00',
    )
    .option(
      '--genesis-batch-hash <hex>',
      'Initialize genesisBatchHash Bytes<32> (64 hex chars). Default: 0x00..00',
    )
    .option(
      '--verifier-set <json>',
      'Initialize verifierSet as JSON array of exactly 3 points: [{"x":"...","y":"..."}, ...]',
    )
    .option('--signature-threshold <n>', 'Initialize signatureThreshold Uint<8> (decimal). Default: 1')
    .option(
      '--initial-sequencer <hex>',
      'Initialize initialSequencer Bytes<32> (64 hex chars). Default: deployer coin public key',
    )
    .option(
      '--initial-finalizer <hex>',
      'Initialize initialFinalizer Bytes<32> (64 hex chars). Default: 0x00..00',
    )
    .action(
      async (subOpts: {
        deployerSeed?: string;
        owner?: string;
        layer2ChainId?: string;
        rollupId?: string;
        genesisStateRoot?: string;
        genesisBatchHash?: string;
        verifierSet?: string;
        signatureThreshold?: string;
        initialSequencer?: string;
        initialFinalizer?: string;
      }) => {
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
        owner: subOpts.owner,
        layer2ChainId: subOpts.layer2ChainId,
        rollupId: subOpts.rollupId,
        genesisStateRoot: subOpts.genesisStateRoot,
        genesisBatchHash: subOpts.genesisBatchHash,
        verifierSet: subOpts.verifierSet,
        signatureThreshold: subOpts.signatureThreshold,
        initialSequencer: subOpts.initialSequencer,
        initialFinalizer: subOpts.initialFinalizer,
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

  program
    .command('deposit')
    .description(
      'Deposit unshielded NIGHT to L2 (call depositNIGHTUnshielded). Requires wallet. Optional --l2-recipient (64 hex); default is wallet\'s coin public key.',
    )
    .requiredOption('--amount <amount>', 'Amount in NIGHT (decimal string)')
    .option('--l2-recipient <hex>', 'L2 recipient (32 bytes, 64 hex chars). Default: wallet\'s coin public key')
    .option('--gas-limit <n>', 'Gas limit for L2 (decimal). Default: 100000', '100000')
    .option('--timestamp <n>', 'Deposit message timestamp (decimal). Default: 0', '0')
    .action(
      async (subOpts: { amount: string; l2Recipient?: string; gasLimit: string; timestamp: string }) => {
        const opts = program.opts();
        const cliConfig = resolveCliConfig({
          contract: opts.contract,
          indexer: opts.indexer,
          indexerWS: opts.indexerWs,
          node: opts.node,
          proofServer: opts.proofServer,
          network: opts.network,
        });
        await runDeposit(cliConfig, {
          amount: subOpts.amount,
          l2Recipient: subOpts.l2Recipient,
          gasLimit: subOpts.gasLimit,
          timestamp: subOpts.timestamp,
          json: opts.json,
        });
      },
    );

  program
    .command('relay-withdraw-night-with-proof')
    .description(
      'Relay a withdraw proof (call relayWithdrawNIGHTWithProof). Requires --l2-sender, --recipient, --amount, --batch-index, --nonce, --index-bits, --siblings.',
    )
    .requiredOption('--l2-sender <hex>', 'L2 sender address (32 bytes, 64 hex chars)')
    .requiredOption('--recipient <hex>', 'L1 recipient address (32 bytes, 64 hex chars)')
    .requiredOption('--amount <amount>', 'Amount (decimal string)')
    .requiredOption('--batch-index <n>', 'Batch index (decimal string)')
    .requiredOption('--nonce <n>', 'Withdraw nonce (decimal string)')
    .requiredOption(
      '--index-bits <json>',
      'Proof index bits as JSON boolean array (length 16, LSB-first), e.g. \'[false,true,...]\'',
    )
    .requiredOption(
      '--siblings <json>',
      'Proof siblings as JSON hex array (length 16), e.g. \'["ab..","cd..",...]\'',
    )
    .action(
      async (subOpts: {
        l2Sender: string;
        recipient: string;
        amount: string;
        batchIndex: string;
        nonce: string;
        indexBits: string;
        siblings: string;
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
        await runRelayWithdrawNightWithProof(cliConfig, {
          l2Sender: subOpts.l2Sender,
          recipient: subOpts.recipient,
          amount: subOpts.amount,
          batchIndex: subOpts.batchIndex,
          nonce: subOpts.nonce,
          indexBits: subOpts.indexBits,
          siblings: subOpts.siblings,
          json: opts.json,
        });
      },
    );

  program
    .command('test-withdraw')
    .description(
      'Run end-to-end withdrawal flow: set-verifier-set, deposit, finalize-batch, relay-withdraw-night-with-proof, and claim-l1-withdrawal-unshielded.',
    )
    .option('--deposit-amount <amount>', 'Deposit amount (decimal). Default: derived from wallet balance')
    .option('--withdraw-amount <amount>', 'Withdraw amount (decimal). Default: deposit/2')
    .option('--claim-amount <amount>', 'Claim amount (decimal). Default: withdraw-1 when possible')
    .option('--recipient <hex>', 'Recipient address (32 bytes, 64 hex chars). Default: random sample user')
    .option('--l2-sender <hex>', 'L2 sender (32 bytes, 64 hex chars). Default: zero bytes')
    .option('--l2-recipient <hex>', 'L2 recipient for deposit (32 bytes, 64 hex chars). Default: wallet coin key')
    .option('--gas-limit <n>', 'Deposit gas limit (decimal). Default: 120000', '120000')
    .option('--timestamp <n>', 'Deposit timestamp (decimal). Default: 0', '0')
    .option('--signer-bitmap <n>', 'Finalize signer bitmap (decimal). Default: default signer bitmap')
    .option('--finalize-timestamp <n>', 'Finalize timestamp (decimal). Default: 0', '0')
    .option('--skip-set-verifier-set', 'Skip the set-verifier-set step')
    .option('--wait-attempts <n>', 'Polling attempts for async state checks. Default: 20', '20')
    .option('--wait-delay-ms <n>', 'Polling delay in ms. Default: 3000', '3000')
    .action(
      async (subOpts: {
        depositAmount?: string;
        withdrawAmount?: string;
        claimAmount?: string;
        recipient?: string;
        l2Sender?: string;
        l2Recipient?: string;
        gasLimit: string;
        timestamp: string;
        signerBitmap?: string;
        finalizeTimestamp: string;
        skipSetVerifierSet?: boolean;
        waitAttempts: string;
        waitDelayMs: string;
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
        await runTestWithdraw(cliConfig, {
          depositAmount: subOpts.depositAmount,
          withdrawAmount: subOpts.withdrawAmount,
          claimAmount: subOpts.claimAmount,
          recipient: subOpts.recipient,
          l2Sender: subOpts.l2Sender,
          l2Recipient: subOpts.l2Recipient,
          gasLimit: subOpts.gasLimit,
          timestamp: subOpts.timestamp,
          signerBitmap: subOpts.signerBitmap,
          finalizeTimestamp: subOpts.finalizeTimestamp,
          skipSetVerifierSet: subOpts.skipSetVerifierSet,
          waitAttempts: subOpts.waitAttempts,
          waitDelayMs: subOpts.waitDelayMs,
          json: opts.json,
        });
      },
    );

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
