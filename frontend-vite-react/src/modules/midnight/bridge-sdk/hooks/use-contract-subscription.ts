
import { DerivedState } from "../api/common-types";
import { useCallback, useEffect, useState } from "react";
import { ContractControllerInterface } from "../api/contractController";
import { Observable } from "rxjs";
import { useWallet } from "../../wallet-widget/hooks/useWallet";
import { ContractDeployment, ContractFollow } from "../contexts";
import { useDeployedContracts } from "./use-deployment";
import { useProviders } from "./use-providers";

export const useContractSubscription = () => {
  const { status } = useWallet();
  const providers = useProviders();
  const deploy = useDeployedContracts();

  const [bridgeDeploymentObservable, setBridgeDeploymentObservable] =
    useState<Observable<ContractDeployment> | undefined>(undefined);

  const [contractDeployment, setContractDeployment] =
    useState<ContractDeployment>();
  const [deployedContractAPI, setDeployedContractAPI] =
    useState<ContractControllerInterface>();
  const [derivedState, setDerivedState] = useState<DerivedState>();

  const onDeploy = async (): Promise<ContractFollow> => {
    const contractFollow = await deploy.deployContract();
    setBridgeDeploymentObservable(contractFollow.observable);
    return contractFollow;
  };

  const onJoin = useCallback(async (): Promise<void> => {
    setBridgeDeploymentObservable(deploy.joinContract().observable);
  }, [deploy, setBridgeDeploymentObservable]);

  useEffect(() => {
    if (status?.status === "connected" && providers) {
      void onJoin();
    }
  }, [onJoin, status?.status, providers]);

  useEffect(() => {
    if (!bridgeDeploymentObservable) {
      return;
    }
    const subscription = bridgeDeploymentObservable.subscribe(
      setContractDeployment
    );

    return () => {
      subscription.unsubscribe();
    };
  }, [bridgeDeploymentObservable]);

  useEffect(() => {
    if (!contractDeployment) {
      return;
    }

    if (
      contractDeployment.status === "in-progress" ||
      contractDeployment.status === "failed"
    ) {
      return;
    }
    setDeployedContractAPI(contractDeployment.api);
  }, [contractDeployment, setDeployedContractAPI]);

  useEffect(() => {
    if (deployedContractAPI) {
      const subscriptionDerivedState =
        deployedContractAPI.state$.subscribe(setDerivedState);
      return () => {
        subscriptionDerivedState.unsubscribe();
      };
    }
  }, [deployedContractAPI]);

  return {       
    deployedContractAPI,
    derivedState,
    onDeploy,
    providers
  };
};
