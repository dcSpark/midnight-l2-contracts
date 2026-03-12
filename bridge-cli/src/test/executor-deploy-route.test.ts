import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutorServer } from '../executor-server.js';
import { runDeploy } from '../commands/deploy.js';

vi.mock('../commands/deploy.js', () => ({
  runDeploy: vi.fn(async () => ({
    contractAddress: 'a'.repeat(64),
    networkLabel: 'test',
  })),
}));

const postJson = async (
  port: number,
  path: string,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; body: unknown }> =>
  await new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port,
        path,
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: res.statusCode ?? 0,
            body: text.length > 0 ? JSON.parse(text) : null,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });

describe('executor /deploy route', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
    server = undefined;
    vi.clearAllMocks();
  });

  it('forwards constructor override payload to runDeploy', async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    } as any;
    const executorContext = { providers: { mock: true } } as any;
    server = await createExecutorServer({
      executorContext,
      cliConfig: {} as any,
      deployConfig: {} as any,
      logger,
    });

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const payload = {
      deployerSeed: '11'.repeat(32),
      owner: '22'.repeat(32),
      layer2ChainId: '7',
      rollupId: '33'.repeat(32),
      genesisStateRoot: '44'.repeat(32),
      genesisBatchHash: '55'.repeat(32),
      verifierSet: [
        { x: '1', y: '2' },
        { x: '3', y: '4' },
        { x: '5', y: '6' },
      ],
      signatureThreshold: '2',
      initialSequencer: '66'.repeat(32),
      initialFinalizer: '77'.repeat(32),
    };
    const res = await postJson(port, '/deploy', payload);

    expect(res.statusCode).toBe(200);
    expect(runDeploy).toHaveBeenCalledOnce();
    expect(runDeploy).toHaveBeenCalledWith(
      {},
      {
        ...payload,
        json: true,
      },
      executorContext,
    );
  });
});
