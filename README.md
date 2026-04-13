# Midnight rollup Bridge contract

This repository contains the on-chain bridge contract and supporting tooling for the Midnight L2 rollup. The bridge contract, written in [Compact](https://docs.midnight.network/relnotes/compact-tools), is deployed on the Midnight L1 and enables bidirectional asset transfers between L1 and the Sovereign SDK rollup (L2). Key capabilities include unshielded NIGHT deposits (L1→L2), proof-based withdrawal claims (L2→L1), batch commitment and finalization with threshold signatures, and verifier set / sequencer / finalizer management. The project ships as a Turbo monorepo with two packages: the Compact smart contract (`bridge-contract`) and a TypeScript CLI and executor service (`bridge-cli`) used by the rollup node to submit L1 transactions.

## 📦 Prerequisites

- [Node.js](https://nodejs.org/) (v23+) & [npm](https://www.npmjs.com/) (v11+)
- [Docker](https://docs.docker.com/get-docker/)
- [Git LFS](https://git-lfs.com/) (for large files)
- [Compact](https://docs.midnight.network/relnotes/compact-tools) (Midnight developer tools)
- [Lace](https://chromewebstore.google.com/detail/hgeekaiplokcnmakghbdfbgnlfheichg?utm_source=item-share-cb) (Browser wallet extension)
- [Faucet](https://faucet.preview.midnight.network/) (Preview Network Faucet)

## 🛠️ Setup

### 1️⃣ Install Git LFS

```bash
# Install and initialize Git LFS
sudo dnf install git-lfs  # For Fedora/RHEL
git lfs install
```

### 2️⃣ Install Compact Tools

```bash
# Install the latest Compact tools
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
```
```bash
# Install the latest compiler
compact update +0.30.0
```

### 3️⃣ Install Node.js and docker
- [Node.js](https://nodejs.org/) & [npm](https://www.npmjs.com/)
- [Docker](https://docs.docker.com/get-docker/)

### 4️⃣ Verify Installation
```bash
# Check versions
node -v  
npm -v   
docker -v
git lfs version
compact check  # Should show latest version
```

## 📁 Project Structure

```
├── bridge-cli/         # CLI tools
└── bridge-contract/    # Smart contracts
```

## 🔗 Setup Instructions

## Initialize or clone the codebase with submodules

This project uses a git submodule for the Compact compiler (as docs for AI). Clone with:

```bash
git clone --recurse-submodules <repo-url>
```

If you already cloned without submodules:

```bash
git submodule update --init

### Install Project Dependencies and compile contracts
  ```bash
   # In one terminal (from project root)
   npm install
   npm run build
   ```

### Setup Env variables

1. **Create .env file from template under bridge-cli folder**
   - [`bridge-cli/.env_template`](./bridge-cli/.env_template)

### Start Development In Undeployed Network
   ```bash
   # From project root
   npm run setup-standalone
   ```
---

### Bridge contract deployment

The Bridge contract is deployed with **bridge-cli** (standalone CLI or via the executor's `POST /deploy` endpoint). Quick start: from project root run `npm run setup-standalone`, then e.g. `cd bridge-cli && npm run deploy-undeployed`, or `npm run cli -- deploy -n undeployed` with env set (see `bridge-cli/.env_template`). All constructor arguments (owner, layer2ChainId, rollupId, genesis roots, verifier set, signatureThreshold, initialSequencer, initialFinalizer) are optional and can be overridden. See [bridge-cli/README.md](bridge-cli/README.md) for deploy options, constructor override flags, and executor usage.

---

<div align="center"><p>Built with ❤️ by <a href="https://meshjs.dev">Mesh</a> × <a href="https://eddalabs.io">Edda Labs</a></p></div>
