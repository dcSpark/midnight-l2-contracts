/**
 * Executor service: long-lived process that builds wallet and contract once,
 * then exposes CLI commands as HTTP endpoints.
 */
import 'dotenv/config';
import { WebSocket } from 'ws';
import http from 'node:http';
import { resolveCliConfig, resolveDeployConfig } from './cli-config.js';
import { buildExecutorContext, type ExecutorContext } from './executor-context.js';
import * as api from './api.js';
import { createLogger } from './logger.js';
import path from 'node:path';
import { currentDir } from './config.js';
import { runState } from './commands/state.js';
import { runDeploy } from './commands/deploy.js';
import { runCommitBatch } from './commands/commit-batch.js';
import {
  runFinalizeBatch,
  runFinalizeBatchFromLedger,
} from './commands/finalize-batch.js';
import {
  hashBatchPublicDataV1Full,
  buildSignatureVector,
  signaturesToJson,
  parseBatchPublicDataFromJson,
  parseSignaturesFromJson,
} from './batch-helpers.js';
import { runSetVerifierSet } from './commands/set-verifier-set.js';
import { runClaimL1WithdrawalUnshielded } from './commands/claim-l1-withdrawal-unshielded.js';
import { runDeposit } from './commands/deposit.js';
import { runRelayWithdrawNightWithProof } from './commands/relay-withdraw-night-with-proof.js';
import { runTestWithdraw } from './commands/test-withdraw.js';

// Required for Midnight indexer/sdk in Node
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

const PORT = Number(process.env.EXECUTOR_PORT ?? process.env.PORT ?? 3000);
const HOST = process.env.EXECUTOR_HOST ?? '0.0.0.0';

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = statusCode;
  res.end(JSON.stringify(data));
}

function sendError(res: http.ServerResponse, statusCode: number, message: string): void {
  sendJson(res, statusCode, { error: message });
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function parseQuery(url: string): URLSearchParams {
  const i = url.indexOf('?');
  return new URLSearchParams(i >= 0 ? url.slice(i) : '');
}

export async function createExecutorServer(ctx: {
  executorContext: ExecutorContext;
  cliConfig: ReturnType<typeof resolveCliConfig>;
  deployConfig: ReturnType<typeof resolveDeployConfig>;
  logger: Awaited<ReturnType<typeof createLogger>>;
}): Promise<http.Server> {
  const { executorContext, cliConfig, deployConfig, logger } = ctx;

  return http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    const pathname = url.split('?')[0];
    const method = req.method ?? 'GET';
    const start = Date.now();

    const handleError = (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, pathname, method }, 'Executor request error');
      sendError(res, 500, message);
    };

    try {
      // GET /health or /ready
      if ((pathname === '/health' || pathname === '/ready') && method === 'GET') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      logger.info({ method, pathname }, 'Executor request');

      // GET /state
      if (pathname === '/state' && method === 'GET') {
        const result = await runState(cliConfig, { json: true, skipPrint: true });
        sendJson(res, 200, result);
        return;
      }

      if (method === 'POST') {
        let body: Record<string, unknown> = {};
        try {
          body = (await parseBody(req)) as Record<string, unknown>;
        } catch {
          sendError(res, 400, 'Invalid JSON body');
          return;
        }

        // POST /commit-batch
        if (pathname === '/commit-batch') {
          const parentHash = body.parentHash as string;
          const batchHash = body.batchHash as string;
          if (!parentHash || !batchHash) {
            sendError(res, 400, 'parentHash and batchHash required');
            return;
          }
          const result = await runCommitBatch(
            cliConfig,
            { parentHash, batchHash },
            executorContext,
          );
          sendJson(res, 200, result);
          return;
        }

        // POST /finalize-batch
        if (pathname === '/finalize-batch') {
          const batchPublicDataRaw = body.batchPublicData;
          const signaturesRaw = body.signatures;
          const signerBitmap = body.signerBitmap;
          const finalizeTimestamp = body.finalizeTimestamp;
          if (
            batchPublicDataRaw === undefined ||
            signaturesRaw === undefined ||
            signerBitmap === undefined ||
            finalizeTimestamp === undefined
          ) {
            sendError(
              res,
              400,
              'batchPublicData, signatures, signerBitmap, finalizeTimestamp required',
            );
            return;
          }
          const batchPublicData =
            typeof batchPublicDataRaw === 'string'
              ? parseBatchPublicDataFromJson(batchPublicDataRaw)
              : parseBatchPublicDataFromJson(JSON.stringify(batchPublicDataRaw));
          const signatures = parseSignaturesFromJson(
            typeof signaturesRaw === 'string' ? signaturesRaw : JSON.stringify(signaturesRaw),
          );
          const result = await runFinalizeBatch(
            cliConfig,
            {
              batchPublicData,
              signatures,
              signerBitmap: BigInt(Number(signerBitmap)),
              finalizeTimestamp: BigInt(Number(finalizeTimestamp)),
            },
            executorContext,
          );
          sendJson(res, 200, result);
          return;
        }

        // POST /finalize-batch-from-ledger
        if (pathname === '/finalize-batch-from-ledger') {
          const result = await runFinalizeBatchFromLedger(
            cliConfig,
            { json: true },
            executorContext,
          );
          sendJson(res, 200, result);
          return;
        }

        // POST /set-verifier-set
        if (pathname === '/set-verifier-set') {
          const result = await runSetVerifierSet(cliConfig, {}, executorContext);
          sendJson(res, 200, result);
          return;
        }

        // POST /claim-l1-withdrawal-unshielded
        if (pathname === '/claim-l1-withdrawal-unshielded') {
          const recipient = body.recipient as string;
          const amount = body.amount as string;
          if (!recipient || !amount) {
            sendError(res, 400, 'recipient and amount required');
            return;
          }
          const result = await runClaimL1WithdrawalUnshielded(
            cliConfig,
            { recipient, amount },
            executorContext,
          );
          sendJson(res, 200, result);
          return;
        }

        // POST /deposit
        if (pathname === '/deposit') {
          const amount = body.amount as string;
          if (!amount) {
            sendError(res, 400, 'amount required');
            return;
          }
          const result = await runDeposit(
            cliConfig,
            {
              amount,
              l2Recipient: body.l2Recipient as string | undefined,
              gasLimit: body.gasLimit != null ? String(body.gasLimit) : undefined,
              timestamp: body.timestamp != null ? String(body.timestamp) : undefined,
            },
            executorContext,
          );
          sendJson(res, 200, result);
          return;
        }

        // POST /relay-withdraw-night-with-proof
        if (pathname === '/relay-withdraw-night-with-proof') {
          const required = [
            'l2Sender',
            'recipient',
            'amount',
            'batchIndex',
            'nonce',
            'indexBits',
            'siblings',
          ];
          for (const key of required) {
            if (body[key] === undefined) {
              sendError(res, 400, `${key} required`);
              return;
            }
          }
          const result = await runRelayWithdrawNightWithProof(
            cliConfig,
            {
              l2Sender: body.l2Sender as string,
              recipient: body.recipient as string,
              amount: body.amount as string,
              batchIndex: body.batchIndex as string,
              nonce: body.nonce as string,
              indexBits:
                typeof body.indexBits === 'string'
                  ? body.indexBits
                  : JSON.stringify(body.indexBits),
              siblings:
                typeof body.siblings === 'string'
                  ? body.siblings
                  : JSON.stringify(body.siblings),
            },
            executorContext,
          );
          sendJson(res, 200, result);
          return;
        }

        // POST /test-withdraw
        if (pathname === '/test-withdraw') {
          const result = await runTestWithdraw(
            cliConfig,
            {
              depositAmount: body.depositAmount as string | undefined,
              withdrawAmount: body.withdrawAmount as string | undefined,
              claimAmount: body.claimAmount as string | undefined,
              recipient: body.recipient as string | undefined,
              l2Sender: body.l2Sender as string | undefined,
              l2Recipient: body.l2Recipient as string | undefined,
              gasLimit: body.gasLimit != null ? String(body.gasLimit) : undefined,
              timestamp: body.timestamp != null ? String(body.timestamp) : undefined,
              signerBitmap: body.signerBitmap != null ? String(body.signerBitmap) : undefined,
              finalizeTimestamp:
                body.finalizeTimestamp != null ? String(body.finalizeTimestamp) : undefined,
              skipSetVerifierSet: body.skipSetVerifierSet === true,
              waitAttempts: body.waitAttempts != null ? String(body.waitAttempts) : undefined,
              waitDelayMs: body.waitDelayMs != null ? String(body.waitDelayMs) : undefined,
            },
            executorContext,
          );
          sendJson(res, 200, result);
          return;
        }

        // POST /deploy
        if (pathname === '/deploy') {
          const result = await runDeploy(
            deployConfig,
            {
              deployerSeed: body.deployerSeed as string | undefined,
              json: true,
            },
            executorContext,
          );
          sendJson(res, 200, result);
          return;
        }

        // POST /build-signatures
        if (pathname === '/build-signatures') {
          const batchPublicDataRaw = body.batchPublicData;
          const signatureMaxNonce = body.signatureMaxNonce as number | undefined;
          if (batchPublicDataRaw === undefined) {
            sendError(res, 400, 'batchPublicData required');
            return;
          }
          const jsonStr =
            typeof batchPublicDataRaw === 'string'
              ? batchPublicDataRaw
              : JSON.stringify(batchPublicDataRaw);
          const bpd = parseBatchPublicDataFromJson(jsonStr);
          const digest = hashBatchPublicDataV1Full(bpd);
          const maxNonce =
            signatureMaxNonce !== undefined && signatureMaxNonce > 0
              ? BigInt(signatureMaxNonce)
              : undefined;
          const sigs = buildSignatureVector(digest, maxNonce);
          const signatures = signaturesToJson(sigs);
          sendJson(res, 200, { signatures });
          return;
        }
      }

      sendError(res, 404, 'Not Found');
    } catch (err) {
      handleError(err);
    } finally {
      const duration = Date.now() - start;
      const status = res.statusCode;
      if (pathname !== '/health' && pathname !== '/ready') {
        logger.info({ method, pathname, status, durationMs: duration }, 'Executor response');
      }
    }
  });
}

async function main(): Promise<void> {
  const logPath = path.resolve(
    currentDir,
    '..',
    'logs',
    'bridge-cli',
    `executor-${new Date().toISOString()}.log`,
  );
  const logger = await createLogger(logPath);
  api.setLogger(logger);

  logger.info('Resolving CLI config from env...');
  const cliConfig = resolveCliConfig();
  const deployConfig = resolveDeployConfig();

  logger.info('Building executor context (wallet, sync, providers, join contract)...');
  const executorContext = await buildExecutorContext(cliConfig);
  logger.info('Executor context ready.');

  const server = await createExecutorServer({
    executorContext,
    cliConfig,
    deployConfig,
    logger,
  });

  const shutdown = () => {
    logger.info('Shutting down: closing wallet...');
    api.closeWallet(executorContext.walletContext).then(
      () => {
        logger.info('Wallet closed.');
        process.exit(0);
      },
      (err) => {
        logger.error({ err }, 'Error closing wallet');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(PORT, HOST, () => {
    logger.info({ host: HOST, port: PORT }, 'Executor service listening');
    console.error(`Executor service listening on http://${HOST}:${PORT}`);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
