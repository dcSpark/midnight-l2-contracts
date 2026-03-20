import path from 'path';
import * as api from '../api';
import { Config, currentDir } from '../config';
import { createLogger } from '../logger';

import { describe, it, beforeAll, afterAll } from 'vitest';
import 'dotenv/config';
import * as Rx from 'rxjs';
import { TestEnvironment } from './simulators/simulator';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { tokenValue } from './utils/utils';

const runningEnvTests = process.env.RUN_ENV_TESTS === 'true';
const network = runningEnvTests ? process.env.TEST_ENV ?? 'preview' : 'undeployed';

if (runningEnvTests && !process.env.TEST_ENV) {
  process.env.TEST_ENV = network;
}

if (network === 'preview' && !process.env.MY_PREVIEW_MNEMONIC) {
  throw new Error('MY_PREVIEW_MNEMONIC must be set to run preview network wallet tests.');
}

const logDir = path.resolve(
  currentDir,
  '..',
  'logs',
  network === 'preview' ? 'test-preview' : 'test-undeployed',
  `${new Date().toISOString()}.log`,
);
const logger = await createLogger(logDir);

describe('API', () => {
  let testEnvironment: TestEnvironment;
  let wallet: api.WalletContext;
  let configuration: Config;

  beforeAll(
    async () => {
      api.setLogger(logger);
      testEnvironment = new TestEnvironment(logger);
      const testConfiguration = await testEnvironment.start();
      logger.info(`Test configuration: ${JSON.stringify(testConfiguration)}`);
      configuration = testConfiguration.dappConfig;
      wallet = await testEnvironment.getWallet();
      await api.configureProviders(wallet, configuration);
    },
    1000 * 60 * 45,
  );

  afterAll(async () => {
    await testEnvironment.shutdown();
  });

  it('allows to transfer shielded tokens only', async () => {
    const state = await Rx.firstValueFrom(wallet.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
    const stateReceiverAddress = state.shielded.address;
    // stateAddress: "coinPublicKey" & "encryptionPublicKey" - Bytes
    logger.info({
      section: 'Shielded Address',
      stateReceiverAddress,
    });
    const ttl = new Date(Date.now() + 60 * 60 * 1000);
    const transfer = await wallet.wallet.transferTransaction(
      [
        {
          type: 'shielded',
          outputs: [
            {
              type: ledger.shieldedToken().raw,
              receiverAddress: stateReceiverAddress,
              amount: tokenValue(1n),
            },
          ],
        },
      ],
      {
        shieldedSecretKeys: wallet.shieldedSecretKeys,
        dustSecretKey: wallet.dustSecretKey,
      },
      { ttl },
    );

    const finalizedTx = await wallet.wallet.finalizeRecipe(transfer);
    const submittedTxHash = await wallet.wallet.submitTransaction(finalizedTx);
    logger.info({
      section: 'Submitted Transaction Hash',
      submittedTxHash,
    });

    await Rx.firstValueFrom(
      wallet.wallet
        .state()
        .pipe(Rx.filter((s) => s.shielded.availableCoins.some((c) => c.coin.value === tokenValue(1n)))),
    );
  });
});
