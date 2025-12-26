// Deploy and interact with L2 contracts on Preview Testnet
// Requires: docker run -p 6300:6300 midnightnetwork/proof-server:6.1.0-alpha.6 -- midnight-proof-server --network preview

import { createLogger } from './logger-utils.js';
import { run } from './cli.js';
import { PreviewConfig } from './config.js';

const config = new PreviewConfig();
const logger = await createLogger(config.logDir);

console.log('\n=== L2 Contracts - Preview Testnet ===\n');
console.log('Endpoints:');
console.log(`  Indexer: ${config.indexer}`);
console.log(`  Node: ${config.node}`);
console.log(`  Proof Server: ${config.proofServer}`);
console.log('\nMake sure the proof server is running:');
console.log('  docker run -p 6300:6300 midnightnetwork/proof-server:6.1.0-alpha.6 -- midnight-proof-server --network preview\n');

await run(config, logger);


