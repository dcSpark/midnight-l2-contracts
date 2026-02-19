import 'dotenv/config';
import path from 'path';
import * as api from '../api';
import { currentDir } from '../config';
import { createLogger } from '../logger';
import { TestEnvironment } from '../test/simulators/simulator';
import { sendArbitraryUnshieldedToken } from '../test/utils/wallet-transfers';

const logDir = path.resolve(currentDir, '..', 'logs', 'setup-undeployed', `${new Date().toISOString()}.log`);
const logger = await createLogger(logDir);

async function setupStandalone() {
  api.setLogger(logger);
  const testEnvironment = new TestEnvironment(logger);
  await testEnvironment.start();
  const wallet = await testEnvironment.getWallet();

  const address = process.env.MY_UNDEPLOYED_UNSHIELDED_ADDRESS?.trim();
  if (address) {
    try {
      const result = await sendArbitraryUnshieldedToken(wallet, address, 1000000000n);
      logger.info(`address keystore ${wallet.unshieldedKeystore.getAddress()}`);
      logger.info(result);
    } catch (error) {
      const decoded = api.decodeRpcError(error);
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({ error: err, decoded }, 'Setup failed');
    }
  } else {
    logger.info(
      'MY_UNDEPLOYED_UNSHIELDED_ADDRESS not set; skipping test transfer. Set it in .env to send a test transfer to that address.',
    );
  }
  // Keep the process running forever
  logger.info('Setup complete. Keeping container alive forever...');
  await new Promise(() => {}); // This never resolves
}
setupStandalone().catch((error) => {
  const decoded = api.decodeRpcError(error);
  const err = error instanceof Error ? error : new Error(String(error));
  logger.error({ error: err, decoded }, 'Setup standalone failed');
});
