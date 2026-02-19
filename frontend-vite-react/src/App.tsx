import { BrowserRouter, Route, Routes } from "react-router-dom";
import * as pino from "pino";
import { MainLayout } from "./layouts/layout";
import { Home } from "./pages/home/";
import { Bridge } from "./pages/bridge";
import { WalletUI } from "./pages/wallet-ui";
import { ThemeProvider } from "./components/theme-provider";
import { MidnightMeshProvider } from "./modules/midnight/wallet-widget/contexts/wallet";
import { BridgeAppProvider } from "./modules/midnight/bridge-sdk/contexts";

export const logger = pino.pino({
  level: "trace",
});

// Update this with your deployed contract address
const contractAddress = import.meta.env.VITE_CONTRACT_ADDRESS!; 

function App() { 
  return (
    <ThemeProvider defaultTheme="light" storageKey="vite-ui-theme">
      <MidnightMeshProvider logger={logger}>
        <BridgeAppProvider logger={logger} contractAddress={contractAddress}>
          <BrowserRouter basename="/">
            <Routes>
              <Route element={<MainLayout />}>
                <Route path="/" element={<Home />} />
                <Route path="/wallet-ui" element={<WalletUI />} />
                <Route path="/bridge" element={<Bridge />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </BridgeAppProvider>
      </MidnightMeshProvider>
    </ThemeProvider>
  );
}

export default App;
