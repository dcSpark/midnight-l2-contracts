import * as ledger from '@midnight-ntwrk/ledger-v8';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { CombinedTokenTransfer } from '@midnight-ntwrk/wallet-sdk-facade';
import * as api from '../../api';
import { tokenValue } from './utils';

//allows to transfer unshielded tokens
//TODO: correct error with address
export async function sendUnshieldedToken(wallet: api.WalletContext, address: string, amount: bigint): Promise<string> {
  const selfBech32 = wallet.unshieldedKeystore.getBech32Address();
  const receiverAddress = UnshieldedAddress.codec.decode(selfBech32.network, selfBech32);
  const tokenTransfer: CombinedTokenTransfer[] = [
    {
      type: 'unshielded',
      outputs: [
        {
          type: ledger.unshieldedToken().raw,
          amount: tokenValue(amount),
          receiverAddress,
        },
      ],
    },
  ];

  const txTtl = new Date(Date.now() + 300 * 60 * 1000); // 30 min

  const transferRecipe = await wallet.wallet.transferTransaction(
    tokenTransfer,
    {
      shieldedSecretKeys: wallet.shieldedSecretKeys,
      dustSecretKey: wallet.dustSecretKey,
    },
    { ttl: txTtl, payFees: true },
  );
  const signedRecipe = await wallet.wallet.signRecipe(transferRecipe, (payload) =>
    wallet.unshieldedKeystore.signData(payload),
  );
  const finalizedTx = await wallet.wallet.finalizeRecipe(signedRecipe);
  const submittedTxHash = await wallet.wallet.submitTransaction(finalizedTx);

  // return txId;
  return submittedTxHash;
}

//allows to transfer arbitrary unshielded tokens
export async function sendArbitraryUnshieldedToken(
  wallet: api.WalletContext,
  address: string,
  amount: bigint,
): Promise<string> {
  //address Hex format
  const addressBech32m = MidnightBech32m.parse(address);
  const addressHex = UnshieldedAddress.codec.decode('undeployed', addressBech32m);

  const outputs = [
    {
      type: ledger.unshieldedToken().raw,
      value: tokenValue(amount),
      // owner: wallet.unshieldedKeystore.getAddress(),
      owner: addressHex.hexString,
    },
  ];

  const intent = ledger.Intent.new(new Date(Date.now() + 30 * 60 * 1000));
  intent.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new([], outputs, []);

  const arbitraryTx = ledger.Transaction.fromParts('undeployed', undefined, undefined, intent);

  const recipe = await wallet.wallet.balanceUnprovenTransaction(
    arbitraryTx,
    {
      shieldedSecretKeys: wallet.shieldedSecretKeys,
      dustSecretKey: wallet.dustSecretKey,
    },
    { ttl: new Date(Date.now() + 30 * 60 * 1000), tokenKindsToBalance: 'all' },
  );

  const signedRecipe = await wallet.wallet.signRecipe(recipe, (payload) => wallet.unshieldedKeystore.signData(payload));
  const finalizedTx = await wallet.wallet.finalizeRecipe(signedRecipe);
  const submittedTxHash = await wallet.wallet.submitTransaction(finalizedTx);

  return submittedTxHash;
}
