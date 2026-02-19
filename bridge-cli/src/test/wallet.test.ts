import path from 'path';
import * as api from '../api';
import { Config, currentDir } from '../config';
import { createLogger } from '../logger';

import { describe, it, beforeAll, afterAll } from 'vitest';
import 'dotenv/config';
import * as Rx from 'rxjs';
import { TestEnvironment } from './simulators/simulator';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { ShieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
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
    const ledgerReceiverAddress = ShieldedAddress.codec
      .encode(configuration.networkId, stateReceiverAddress)
      .asString();
    // stateAddress: "coinPublicKey" & "encryptionPublicKey" - Bytes
    logger.info({
      section: 'Shielded Address',
      stateReceiverAddress,
    });
    // "mn_shield-addr_undeployed14gxh9wmhafr0np4gqrrx6awyus52jk7huyjy78kstym5ucnxawvtvtnrpgpszud4uyd0yjrlqyp7v5xvwqljsng2g79j5w4al9c4kuqm9zs2g"
    logger.info({
      section: 'ledgerReceiverAddress',
      ledgerReceiverAddress,
    });

    const ttl = new Date(Date.now() + 60 * 60 * 1000);
    const transfer = await wallet.wallet.transferTransaction(
      wallet.shieldedSecretKeys,
      wallet.dustSecretKey,
      [
        {
          type: 'shielded',
          outputs: [
            {
              type: ledger.shieldedToken().raw,
              receiverAddress: ledgerReceiverAddress,
              amount: tokenValue(1n),
            },
          ],
        },
      ],
      ttl,
    );

    //proof transaction
    const finalizedTx = await wallet.wallet.finalizeTransaction(transfer);
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
