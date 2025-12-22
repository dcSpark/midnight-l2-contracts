# Midnight L2 contracts

[![Generic badge](https://img.shields.io/badge/Compact%20Compiler-0.28.0-1abc9c.svg)](https://shields.io/) [![Generic badge](https://img.shields.io/badge/TypeScript-5.8.3-blue.svg)](https://shields.io/)

Midnight L1 smart contracts supporting our Midnight L2.

## Project Structure

```
midnight-l2-contracts/
├── compact/                # Compact compiler (git submodule)
├── contract/               # Smart contracts in Compact language
│   ├── src/Bridge.compact        # Main L1+L2 unified bridge contract
│   ├── src/L2Simulation.compact  # Simplified L2 contract for testing/simulation only
│   └── src/test/                 # Contract unit tests
└── cli/                    # Command-line interface
    └── src/                # CLI implementation
```

## Prerequisites

### 1. Node.js Version Check

You need NodeJS version 22.15 or greater:

```bash
node --version
```

Expected output: `v22.15.0` or higher.

If you get a lower version: [Install Node.js 22+](https://nodejs.org/).

### 2. Docker Installation

The [proof server](https://docs.midnight.network/develop/tutorial/using/proof-server) runs in Docker, so you need Docker Desktop:

```bash
docker --version
```

Expected output: `Docker version X.X.X`.

If Docker is not found: [Install Docker Desktop](https://docs.docker.com/desktop/). Make sure Docker Desktop is running (not just installed).

## Setup Instructions

### Clone the Repository

This project uses a git submodule for the Compact compiler. Clone with:

```bash
git clone --recurse-submodules <repo-url>
```

If you already cloned without submodules:

```bash
git submodule update --init
```

### Build the Compact Compiler

The Compact compiler is included as a submodule pinned to `v.0.28.0-alpha.106+ledger6.2`. Build it with Nix:

```bash
cd compact && nix build && cd ..
```

The compiler binary will be available at `./compact/result/bin/compactc`.

### Install Project Dependencies

```bash
npm install
```

### Compile the Smart Contract

The Compact compiler generates TypeScript bindings and zero-knowledge circuits from the smart contract source code. Navigate to contract directory and compile the smart contract:

```bash
cd contract && npm run compact
```

Note: First time may download zero-knowledge parameters (~500MB). This is normal and happens once.

### Build and Test

Build TypeScript files and run tests:

```bash
npm run build && npm run test
```

### Build the CLI Interface

Navigate to CLI directory and build the project:

```bash
cd ../cli && npm run build
```

### QUICKSTART: Run the CLI and play with local Midnight network

To start a local Midnight network (node, indexer) with prover and test over it:

```bash
npm run standalone
```

The CLI will guide you what to do offering choice between actions. The network gets shut down afterwards.

To start components individually, or connect to testnet etc. follow the more detailed instructions below.

### Start the Proof Server

The proof server generates zero-knowledge proofs for transactions locally to protect private data. It must be running before you can deploy or interact with contracts.

#### Option A: Manual Proof Server (Recommended)

Pull the Docker image:

```bash
docker pull midnightnetwork/proof-server:latest
```

Then start the proof server (keep this terminal open):

```bash
docker run -p 6300:6300 midnightnetwork/proof-server -- 'midnight-proof-server --network testnet'
```

Expected output:

```
INFO midnight_proof_server: This proof server processes transactions for TestNet.
INFO actix_server::server: starting service: "actix-web-service-0.0.0.0:6300"
```

**Keep this terminal running!** The proof server must stay active while using the DApp.

#### Option B: Automatic Proof Server

This should start proof server automatically, but may fail if Docker isn't properly configured:

```bash
npm run testnet-remote-ps
```

If this fails with "Could not find a working container runtime strategy", use Option A instead.

## Run the CLI

Open a new terminal (keep proof server running in the first one).

```bash
cd cli && npm run start-testnet-remote
```

## Using the contract from the CLI

### Create a Wallet

The CLI uses a headless wallet (separate from browser wallets like Lace) that can be called through library functions.

1. Choose option `1` to build a fresh wallet
2. The system will generate a wallet address and seed
3. **Save both the address and seed** - you'll need them later

Expected output:

```
Your wallet seed is: [64-character hex string]
Your wallet address is: mn_shield-addr_test1...
Your wallet balance is: 0
```

### Fund Your Wallet

Before deploying contracts, you need testnet tokens.

1. Copy your wallet address from the output above
2. Visit the [testnet faucet](https://midnight.network/test-faucet)
3. Paste your address and request funds
4. Wait for the CLI to detect the funds (takes 2-3 minutes)

Expected output:

```
Your wallet balance is: 1000000000
```

### Deploy Your Contract

1. Choose option `1` to deploy a new contract
2. Wait for deployment (takes ~30 seconds)
3. **Save the contract address** for future use

Expected output:

```
Deployed contract at address: [contract address]
```

### Interact with Your Contract

You can now:

- **Update** the state root (submits a transaction to testnet)
- **Display** current state root value (queries the blockchain)
- **Exit** when done

Each increment creates a real transaction on Midnight Testnet.

### Reusing Your Wallet

Next time you run the DApp:

1. Choose option `2` to build wallet from seed
2. Enter your saved seed
3. Choose option `2` to join existing contract
4. Enter your saved contract address

## Useful Links

- [Testnet Faucet](https://midnight.network/test-faucet) - Get testnet funds
- [Midnight Documentation](https://docs.midnight.network/) - Complete developer guide
- [Compact Language Guide](https://docs.midnight.network/compact) - Smart contract language reference

## Troubleshooting

| Issue                                               | Solution                                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `compact/` folder is empty                          | Run `git submodule update --init`                                                                                       |
| `connect ECONNREFUSED 127.0.0.1:6300`               | Start proof server: `docker run -p 6300:6300 midnightnetwork/proof-server -- 'midnight-proof-server --network testnet'` |
| Could not find a working container runtime strategy | Docker isn't running properly. Restart Docker Desktop and try again                                                     |
| Tests fail with "Cannot find module"                | Compile contract first: `cd contract && npm run compact && npm run build && npm run test`                               |
| Wallet seed validation errors                       | Enter complete 64-character hex string without extra spaces                                                             |
| Node.js warnings about experimental features        | Normal warnings - don't affect functionality                                                                            |
