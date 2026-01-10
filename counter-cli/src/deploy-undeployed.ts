import { createLogger } from "./logger.js";
import { UndeployedConfig } from "./config.js";
import * as api from "./api.js";

const GENESIS_MINT_WALLET_SEED =
  "0000000000000000000000000000000000000000000000000000000000000001";

const deploy = async () => {
  const config = new UndeployedConfig();
  const logger = await createLogger(config.logDir);
  api.setLogger(logger);

  logger.info("Deploying bridge contract on undeployed network...");

  let walletContext: api.WalletContext | null = null;
  try {
    walletContext = await api.buildWalletFromHexSeed(
      config,
      GENESIS_MINT_WALLET_SEED
    );
    const providers = await api.configureProviders(walletContext, config);
    const deployed = await api.deploy(providers, { privateState: 0 });
    const address = deployed.deployTxData.public.contractAddress;

    logger.info(`Bridge deployed at: ${address}`);
    console.log(`BRIDGE_ADDRESS=${address}`);
    console.log(`VITE_CONTRACT_ADDRESS="${address}"`);
  } finally {
    if (walletContext) {
      await api.closeWallet(walletContext);
    }
  }
};

deploy().catch((error) => {
  console.error("Deploy failed:", error);
  process.exitCode = 1;
});
