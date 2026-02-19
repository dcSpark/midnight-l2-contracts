import { Buffer } from 'buffer';
import http from 'node:http';
import https from 'node:https';
import path from 'path';
import type { Logger } from 'pino';
import {
  DockerComposeEnvironment,
  GenericContainer,
  type StartedDockerComposeEnvironment,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import type { WalletContext } from '../../api';
import * as api from '../../api';
import { type Config, currentDir, PreviewConfig, UndeployedConfig } from '../../config';

const GENESIS_MINT_WALLET_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

// Test mnemonic - DO NOT use in production
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

export interface TestConfiguration {
  seed: string;
  mnemonic: string;
  entrypoint: string;
  dappConfig: Config;
  psMode: string;
  cacheFileName: string;
}

type HttpRequestOptions = {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

const httpRequest = (target: string, options: HttpRequestOptions = {}): Promise<number> => {
  const url = new URL(target);
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined && headers['content-length'] === undefined) {
    headers['content-length'] = Buffer.byteLength(options.body).toString();
  }
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.request(
      {
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: `${url.pathname}${url.search}` || '/',
        method: options.method ?? 'GET',
        timeout: options.timeoutMs ?? 5_000,
        headers,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Request timed out'));
    });

    if (options.body !== undefined) {
      request.write(options.body);
    }

    request.end();
  });
};

export class LocalTestConfig implements TestConfiguration {
  seed = GENESIS_MINT_WALLET_SEED;
  mnemonic = TEST_MNEMONIC;
  entrypoint = 'dist/standalone.js';
  psMode = 'undeployed';
  cacheFileName = '';
  dappConfig = new UndeployedConfig();
}

export function parseArgs(required: string[]): TestConfiguration {
  let entry = '';
  if (required.includes('entry')) {
    if (process.env.TEST_ENTRYPOINT !== undefined) {
      entry = process.env.TEST_ENTRYPOINT;
    } else {
      throw new Error('TEST_ENTRYPOINT environment variable is not defined.');
    }
  }

  let seed = GENESIS_MINT_WALLET_SEED;
  let mnemonic = TEST_MNEMONIC;
  if (process.env.TEST_WALLET_SEED !== undefined) {
    seed = process.env.TEST_WALLET_SEED;
  } else if (required.includes('seed')) {
    throw new Error('TEST_WALLET_SEED environment variable is not defined.');
  }

  if (process.env.MY_PREVIEW_MNEMONIC !== undefined) {
    mnemonic = process.env.MY_PREVIEW_MNEMONIC;
  }

  let cfg: Config = new PreviewConfig();
  let env = '';
  let psMode = 'undeployed';
  let cacheFileName = '';
  if (required.includes('env')) {
    if (process.env.TEST_ENV !== undefined) {
      env = process.env.TEST_ENV;
    } else {
      throw new Error('TEST_ENV environment variable is not defined.');
    }
    switch (env) {
      case 'preview':
        cfg = new PreviewConfig();
        psMode = 'preview';
        cacheFileName = `${seed.substring(0, 7)}-${psMode}.state`;
        break;
      case 'undeployed':
        cfg = new UndeployedConfig();
        psMode = 'undeployed';
        cacheFileName = `${seed.substring(0, 7)}-${psMode}.state`;
        break;
      default:
        throw new Error(`Unknown env value=${env}`);
    }
  }

  return {
    seed,
    mnemonic,
    entrypoint: entry,
    dappConfig: cfg,
    psMode,
    cacheFileName,
  };
}

export class TestEnvironment {
  private readonly logger: Logger;
  private env: StartedDockerComposeEnvironment | undefined;
  private dockerEnv: DockerComposeEnvironment | undefined;
  private container: StartedTestContainer | undefined;
  private walletContext: WalletContext | undefined;
  private testConfig: TestConfiguration;

  constructor(logger: Logger) {
    this.logger = logger;
    this.testConfig = new LocalTestConfig();
  }

  start = async (): Promise<TestConfiguration> => {
    if (process.env.RUN_ENV_TESTS === 'true') {
      this.testConfig = parseArgs(['env']);
      this.logger.info(`Test wallet seed: ${this.testConfig.seed}`);
      const configuredProofServer = this.testConfig.dappConfig.proofServer;
      if (await TestEnvironment.proofServerIsHealthy(configuredProofServer)) {
        this.logger.info(`Reusing proof server at ${configuredProofServer}`);
      } else {
        this.logger.info('Proof server starting...');
        this.container = await TestEnvironment.getProofServerContainer(this.testConfig.psMode);
        this.testConfig.dappConfig = {
          ...this.testConfig.dappConfig,
          proofServer: `http://${this.container.getHost()}:${this.container.getMappedPort(6300).toString()}`,
        };
      }
      await this.verifyExistingNetworkServices();
    } else {
      this.testConfig = new LocalTestConfig();
      this.logger.info('Test containers starting...');
      const composeFile = process.env.COMPOSE_FILE ?? 'standalone.yml';
      this.logger.info(`Using compose file: ${composeFile}`);
      this.dockerEnv = new DockerComposeEnvironment(path.resolve(currentDir, '..'), composeFile)
        .withWaitStrategy(
          'bridge-proof-server',
          Wait.forLogMessage('Actix runtime found; starting in Actix runtime', 1),
        )
        .withWaitStrategy('bridge-indexer', Wait.forLogMessage(/indexer_standalone.*starting/, 1));
      this.env = await this.dockerEnv.up();

      this.testConfig.dappConfig = {
        ...this.testConfig.dappConfig,
        indexer: TestEnvironment.mapContainerPort(this.env, this.testConfig.dappConfig.indexer, 'bridge-indexer'),
        indexerWS: TestEnvironment.mapContainerPort(this.env, this.testConfig.dappConfig.indexerWS, 'bridge-indexer'),
        node: TestEnvironment.mapContainerPort(this.env, this.testConfig.dappConfig.node, 'bridge-node'),
        proofServer: TestEnvironment.mapContainerPort(
          this.env,
          this.testConfig.dappConfig.proofServer,
          'bridge-proof-server',
        ),
      };
      await this.waitForLocalServicesReady();
    }
    this.logger.info(`Configuration:${JSON.stringify(this.testConfig)}`);
    this.logger.info('Test containers started');
    return this.testConfig;
  };

  static mapContainerPort = (env: StartedDockerComposeEnvironment, url: string, containerName: string) => {
    const mappedUrl = new URL(url);
    const container = env.getContainer(containerName);

    mappedUrl.port = String(container.getFirstMappedPort());

    return mappedUrl.toString().replace(/\/+$/, '');
  };

  static getProofServerContainer = async (_env: string) =>
    await new GenericContainer('midnightntwrk/proof-server:7.0.1')
      .withExposedPorts(6300)
      .withCommand(['midnight-proof-server', '-v'])
      .withEnvironment({ RUST_BACKTRACE: 'full' })
      .withWaitStrategy(Wait.forLogMessage('Actix runtime found; starting in Actix runtime', 1))
      .start();

  private async verifyExistingNetworkServices(): Promise<void> {
    if (this.testConfig.dappConfig.networkId !== 'undeployed') {
      return;
    }

    if (await TestEnvironment.nodeIsHealthy(this.testConfig.dappConfig.node)) {
      this.logger.info(`Detected running node at ${this.testConfig.dappConfig.node}`);
    } else {
      this.logger.warn(`Unable to reach node at ${this.testConfig.dappConfig.node}; tests may fail`);
    }

    if (await TestEnvironment.indexerIsHealthy(this.testConfig.dappConfig.indexer)) {
      this.logger.info(`Detected running indexer at ${this.testConfig.dappConfig.indexer}`);
    } else {
      this.logger.warn(`Unable to reach indexer at ${this.testConfig.dappConfig.indexer}; tests may fail`);
    }
  }

  private async waitForLocalServicesReady(): Promise<void> {
    const maxAttempts = 30;
    const sleepMs = 2_000;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const nodeHealthy = await TestEnvironment.nodeIsHealthy(this.testConfig.dappConfig.node);
      const indexerHealthy = await TestEnvironment.indexerIsHealthy(this.testConfig.dappConfig.indexer);

      if (nodeHealthy && indexerHealthy) {
        this.logger.info('Node and indexer are healthy.');
        return;
      }

      this.logger.info(
        `Waiting for services to be healthy (attempt ${attempt}/${maxAttempts}): ` +
          `node=${nodeHealthy}, indexer=${indexerHealthy}`,
      );
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }

    this.logger.warn('Timed out waiting for node/indexer readiness; wallet sync may log transient errors.');
  }

  private static async proofServerIsHealthy(baseUrl: string): Promise<boolean> {
    try {
      const url = new URL('/version', baseUrl).toString();
      const status = await httpRequest(url);
      return status >= 200 && status < 500;
    } catch {
      return false;
    }
  }

  private static async nodeIsHealthy(nodeUrl: string): Promise<boolean> {
    const healthUrl = TestEnvironment.nodeHealthUrl(nodeUrl);
    if (healthUrl === null) {
      return false;
    }
    try {
      const status = await httpRequest(healthUrl);
      return status >= 200 && status < 500;
    } catch {
      return false;
    }
  }

  private static async indexerIsHealthy(indexerUrl: string): Promise<boolean> {
    try {
      const status = await httpRequest(indexerUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ query: '{ __typename }' }),
        timeoutMs: 5_000,
      });
      return status >= 200 && status < 300;
    } catch {
      return false;
    }
  }

  private static nodeHealthUrl(nodeUrl: string): string | null {
    try {
      const url = new URL(nodeUrl);
      if (url.protocol === 'ws:') {
        url.protocol = 'http:';
      } else if (url.protocol === 'wss:') {
        url.protocol = 'https:';
      }

      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
      }

      url.pathname = '/health';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return null;
    }
  }

  shutdown = async () => {
    if (this.walletContext !== undefined) {
      await api.closeWallet(this.walletContext);
    }
    if (this.env !== undefined) {
      this.logger.info('Test containers closing');
      await this.env.down();
    }
    if (this.container !== undefined) {
      this.logger.info('Test container closing');
      await this.container.stop();
    }
  };

  getWallet = async (): Promise<WalletContext> => {
    this.logger.info('Setting up wallet');

    // Use hex seed for standalone (genesis wallet), mnemonic for preview
    if (this.testConfig.dappConfig.networkId === 'undeployed') {
      this.walletContext = await api.buildWalletFromHexSeed(this.testConfig.dappConfig, this.testConfig.seed);
    } else {
      this.logger.debug('Using preview mnemonic for wallet setup');
      this.walletContext = await api.buildWalletAndWaitForFunds(this.testConfig.dappConfig, this.testConfig.mnemonic);
    }

    return this.walletContext;
  };
}
