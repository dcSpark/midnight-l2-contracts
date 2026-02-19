import { DeployedProvider } from './bridge-deployment';
import { LocalStorageProvider } from './bridge-localStorage';
import { Provider } from './bridge-providers';
import { Logger } from 'pino';
import { ContractAddress } from '@midnight-ntwrk/compact-runtime';

export * from './bridge-providers';
export * from './bridge-localStorage';
export * from './bridge-localStorage-class';
export * from './bridge-deployment';
export * from './bridge-deployment-class';

interface AppProviderProps {
  children: React.ReactNode;
  logger: Logger;
  contractAddress: ContractAddress;
}

export const BridgeAppProvider = ({ children, logger, contractAddress }: AppProviderProps) => {
  return (
    <LocalStorageProvider logger={logger}>
      <Provider logger={logger}>
        <DeployedProvider logger={logger} contractAddress={contractAddress}>
          {children}
        </DeployedProvider>
      </Provider>
    </LocalStorageProvider>
  );
};
