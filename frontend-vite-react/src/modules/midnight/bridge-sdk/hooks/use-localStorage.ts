import { useContext } from 'react';
import { LocalStorageContext } from '../contexts/bridge-localStorage';
import { LocalStorageProps } from '../contexts/bridge-localStorage-class';

export const useLocalState = (): LocalStorageProps => {
  const context = useContext(LocalStorageContext);

  if (!context) {
    throw new Error('Hook being used outside of the provider');
  }
  return context;
};
