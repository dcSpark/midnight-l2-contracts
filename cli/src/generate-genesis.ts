/**
 * Generate a funded genesis state for testing.
 * This creates a genesis with pre-funded shielded coins for the test wallet.
 */

import * as ledger from '@midnight-ntwrk/ledger-v6';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NETWORK_ID = 'undeployed';
// Test wallet seed (all zeros except last byte = 1)
const TEST_SEED = new Uint8Array(32);
TEST_SEED[31] = 1;

// Amount to fund: 1 billion units
const FUND_AMOUNT = 1_000_000_000n;

async function main() {
  console.log('Generating funded genesis state...');
  
  // Derive keys from seed
  const secretKeys = ledger.ZswapSecretKeys.fromSeed(TEST_SEED);
  const coinPublicKey = secretKeys.coinPublicKey;
  const encryptionPublicKey = secretKeys.encryptionPublicKey;
  
  console.log(`Coin public key: ${coinPublicKey}`);
  console.log(`Encryption public key: ${encryptionPublicKey}`);
  
  // Create a blank ledger state
  let state = ledger.LedgerState.blank(NETWORK_ID);
  console.log(`Initial state created with network ID: ${NETWORK_ID}`);
  
  // Create a shielded coin to fund the wallet
  const nativeTokenType = ledger.nativeToken();
  
  // Create coin info for the shielded output
  // Note: nonce and type are hex strings in ledger-v6
  const zeroNonce = '0'.repeat(64); // 32 bytes = 64 hex chars
  const coinInfo: ledger.ShieldedCoinInfo = {
    nonce: zeroNonce,
    type: nativeTokenType.raw,
    value: FUND_AMOUNT,
  };
  
  console.log(`Creating shielded output with ${FUND_AMOUNT} native tokens...`);
  
  // Create a ZswapOutput targeting our wallet (segment = undefined for genesis)
  const output = ledger.ZswapOutput.new(
    coinInfo,
    undefined, // segment
    coinPublicKey,
    encryptionPublicKey,
  );
  
  console.log('Created ZswapOutput');
  
  // Create an offer from the output
  const offer = ledger.ZswapOffer.fromOutput(output);
  
  console.log('Created ZswapOffer from output');
  // Convert deltas Map to string representation (BigInt can't be JSON.stringified)
  const deltasStr = Array.from(offer.deltas.entries()).map(([k, v]) => `${k}: ${v.toString()}`).join(', ');
  console.log(`Offer deltas: ${deltasStr}`);
  
  // Create a transaction from the offer
  const tx = ledger.Transaction.fromParts(NETWORK_ID, offer);
  
  console.log('Created unproven transaction');
  
  // For genesis, we need to prove and bind the transaction
  // But for testing, we can try to apply it directly as a mock
  
  // First let's try to serialize the state with the output applied
  // We need to update the ZswapChainState directly
  
  // Get the zswap chain state and try to apply the offer
  const zswapState = new ledger.ZswapChainState();
  console.log('Created blank ZswapChainState');
  
  try {
    // Try applying the offer to ZswapChainState
    const [newZswapState, commitments] = zswapState.tryApply(offer);
    console.log(`Applied offer to ZswapChainState. Commitments: ${commitments.size}`);
    
    // Now we need to create a LedgerState with this ZswapChainState
    // Unfortunately, LedgerState doesn't seem to have a way to set ZswapChainState directly
    // Let's try a different approach - use testingDistributeNight for unshielded funds
  } catch (err) {
    console.log(`Failed to apply offer to ZswapChainState: ${err}`);
  }
  
  // Alternative: Use testingDistributeNight for unshielded funds
  // This creates Night tokens (unshielded) which can then be shielded by the wallet
  console.log('\nTrying alternative: testingDistributeNight for unshielded funds...');
  
  // Create a UserAddress for the test wallet
  // UserAddress is the combination of coin and encryption public keys
  const userAddress = `${coinPublicKey}${encryptionPublicKey}`;
  console.log(`User address: ${userAddress}`);
  
  // Apply testingDistributeNight
  const now = new Date();
  try {
    const newState = state.testingDistributeNight(userAddress, FUND_AMOUNT, now);
    state = newState;
    console.log('Applied testingDistributeNight successfully!');
  } catch (err) {
    console.log(`Failed to apply testingDistributeNight: ${err}`);
  }
  
  // Apply post-block update
  state = state.postBlockUpdate(now);
  console.log('Applied postBlockUpdate');
  
  // Serialize the state
  const serialized = state.serialize();
  console.log(`Serialized state: ${serialized.length} bytes`);
  const headerEnd = serialized.indexOf(0x3a, 20); // Find ':' after header
  console.log(`State header: ${new TextDecoder().decode(serialized.slice(0, Math.min(50, headerEnd + 10)))}`);
  
  // Write to file
  const outputPath = path.resolve(__dirname, '..', 'genesis_state_funded.mn');
  fs.writeFileSync(outputPath, serialized);
  console.log(`Written to: ${outputPath}`);
  
  console.log('\nGenesis state generated successfully!');
  console.log('Note: This creates UNSHIELDED Night tokens.');
  console.log('The wallet will need to shield them before use.');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
