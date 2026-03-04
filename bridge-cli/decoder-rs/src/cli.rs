use clap::{ArgAction, Args, Parser, Subcommand};

pub const DEFAULT_INDEXER_HTTP: &str = "http://127.0.0.1:8088/api/v3/graphql";
pub const DEFAULT_CONTRACT_ADDRESS: &str =
    "a23a82433d3f4b13c83d3bbeda1e033f4a92a9e46aa5a81ffd966beafa439b82";

#[derive(Parser, Debug)]
#[command(author, version, about = "Bridge helper CLI")]
pub struct Cli {
    #[command(subcommand)]
    pub command: CommandKind,
}

#[derive(Subcommand, Debug)]
pub enum CommandKind {
    Decode(DecodeArgs),
    CommitBatch(BatchArgs),
    FinalizeBatch(BatchArgs),
    Deposit(DepositArgs),
    SetVerifierSet(BridgeCallArgs),
    RelayWithdrawNightWithProof(RelayWithdrawArgs),
    ClaimL1Withdrawal(ClaimL1WithdrawalArgs),
    TestWithdraw(TestWithdrawArgs),
    /// Set verifier set, then run repeated commit-batch + finalize-batch until error or max attempts.
    TestCost(TestCostArgs),
}

#[derive(Args, Debug, Clone)]
pub struct DecodeArgs {
    /// Bridge contract address (64 hex chars).
    #[arg(long, env = "BRIDGE_CONTRACT_ADDRESS", default_value = DEFAULT_CONTRACT_ADDRESS)]
    pub contract: String,

    /// GraphQL endpoint for the indexer HTTP API.
    #[arg(long, env = "INDEXER_HTTP", default_value = DEFAULT_INDEXER_HTTP)]
    pub indexer: String,
}

#[derive(Args, Debug, Clone)]
pub struct BridgeCallArgs {
    /// Bridge contract address (64 hex chars).
    #[arg(long, env = "BRIDGE_CONTRACT_ADDRESS", default_value = DEFAULT_CONTRACT_ADDRESS)]
    pub contract: String,

    /// GraphQL endpoint for the indexer HTTP API.
    #[arg(long, env = "INDEXER_HTTP", default_value = DEFAULT_INDEXER_HTTP)]
    pub indexer: String,

    /// Midnight node WS endpoint for fetch/send.
    #[arg(long, env = "MIDNIGHT_NODE_WS", default_value = "ws://127.0.0.1:9944")]
    pub node_ws: String,

    /// Proof server URL (used by remote prover).
    #[arg(long, env = "PROOF_SERVER", default_value = "http://127.0.0.1:6300")]
    pub proof_server: String,

    /// Wallet seed used to pay fees (hex, lazy-hex, or mnemonic).
    #[arg(
        long,
        env = "FUNDING_SEED",
        default_value = "0000000000000000000000000000000000000000000000000000000000000001"
    )]
    pub funding_seed: String,

    /// Use local proving instead of the remote proof server.
    #[arg(long, action = ArgAction::SetTrue)]
    pub local_prover: bool,

    /// Fetch concurrency for building ledger context from node history.
    #[arg(long, env = "FETCH_CONCURRENCY", default_value = "20")]
    pub fetch_concurrency: usize,

    /// Bridge artifacts directory (contains keys/ and zkir/).
    #[arg(long, env = "BRIDGE_ARTIFACTS", default_value = "../../bridge-contract/dist/managed/Bridge")]
    pub bridge_artifacts: String,

    /// Executor service URL (e.g. http://127.0.0.1:3000). When set, bridge actions are sent via HTTP instead of TS subprocess.
    #[arg(long, env = "EXECUTOR_URL")]
    pub executor_url: Option<String>,
}

#[derive(Args, Debug, Clone)]
pub struct BatchArgs {
    #[command(flatten)]
    pub bridge: BridgeCallArgs,

    /// Nonce used for signing (base; signers get nonce, nonce+1, nonce+2). Decimal string, can be up to ~255 bits.
    #[arg(long, env = "SIGNATURE_NONCE", default_value = "1")]
    pub signature_nonce: String,
}

#[derive(Args, Debug, Clone)]
pub struct DepositArgs {
    #[command(flatten)]
    pub bridge: BridgeCallArgs,

    /// Amount in NIGHT (decimal string).
    #[arg(long)]
    pub amount: String,

    /// Optional L2 recipient (64 hex chars). Defaults to wallet coin public key in TS CLI.
    #[arg(long)]
    pub l2_recipient: Option<String>,

    /// Optional gas limit for L2 (decimal string). Default in TS CLI: 100000.
    #[arg(long)]
    pub gas_limit: Option<String>,

    /// Optional message timestamp (decimal string). Default in TS CLI: 0.
    #[arg(long)]
    pub timestamp: Option<String>,
}

#[derive(Args, Debug, Clone)]
pub struct RelayWithdrawArgs {
    #[command(flatten)]
    pub bridge: BridgeCallArgs,

    /// L2 sender bytes32 hex.
    #[arg(long)]
    pub l2_sender: String,

    /// L1 recipient bytes32 hex.
    #[arg(long)]
    pub recipient: String,

    /// Withdraw amount (decimal string).
    #[arg(long)]
    pub amount: String,

    /// Proof batch index (decimal string).
    #[arg(long)]
    pub batch_index: String,

    /// Proof nonce (decimal string).
    #[arg(long)]
    pub nonce: String,

    /// Proof index bits as JSON bool array, length 16.
    #[arg(long)]
    pub index_bits: String,

    /// Proof siblings as JSON bytes32-hex array, length 16.
    #[arg(long)]
    pub siblings: String,
}

#[derive(Args, Debug, Clone)]
pub struct ClaimL1WithdrawalArgs {
    #[command(flatten)]
    pub bridge: BridgeCallArgs,

    /// Recipient bytes32 hex.
    #[arg(long)]
    pub recipient: String,

    /// Claim amount (decimal string).
    #[arg(long)]
    pub amount: String,
}

#[derive(Args, Debug, Clone)]
pub struct TestWithdrawArgs {
    #[command(flatten)]
    pub bridge: BridgeCallArgs,

    /// Optional deposit amount. Default: derived from locked_night baseline (minimum 4).
    #[arg(long)]
    pub deposit_amount: Option<String>,

    /// Optional withdraw amount. Default: deposit/2.
    #[arg(long)]
    pub withdraw_amount: Option<String>,

    /// Optional claim amount. Default: withdraw-1 when possible.
    #[arg(long)]
    pub claim_amount: Option<String>,

    /// Optional recipient bytes32 hex. Default: deterministic demo address.
    #[arg(long)]
    pub recipient: Option<String>,

    /// Optional l2 sender bytes32 hex. Default: zero bytes.
    #[arg(long)]
    pub l2_sender: Option<String>,

    /// Optional l2 recipient bytes32 hex for deposit.
    #[arg(long)]
    pub l2_recipient: Option<String>,

    /// Optional gas limit for deposit. Default: 120000.
    #[arg(long)]
    pub gas_limit: Option<String>,

    /// Optional timestamp for deposit. Default: 0.
    #[arg(long)]
    pub timestamp: Option<String>,

    /// Optional signer bitmap for finalize. Default: 7.
    #[arg(long)]
    pub signer_bitmap: Option<u8>,

    /// Optional finalize timestamp. Default: 0.
    #[arg(long)]
    pub finalize_timestamp: Option<u64>,

    /// Skip set-verifier-set step.
    #[arg(long, action = ArgAction::SetTrue)]
    pub skip_set_verifier_set: bool,

    /// Nonce used for signing (base; signers get nonce, nonce+1, nonce+2). Decimal string, up to ~255 bits.
    #[arg(long, env = "SIGNATURE_NONCE", default_value = "1")]
    pub signature_nonce: String,

    /// Poll attempts for async checks.
    #[arg(long, default_value = "20")]
    pub wait_attempts: u32,

    /// Poll delay in milliseconds.
    #[arg(long, default_value = "3000")]
    pub wait_delay_ms: u64,
}

#[derive(Args, Debug, Clone)]
pub struct TestCostArgs {
    #[command(flatten)]
    pub bridge: BridgeCallArgs,

    /// Maximum number of commit+finalize cycles to run before stopping successfully.
    #[arg(long, default_value = "30")]
    pub max_attempts: u32,

    /// Nonce used for finalize-batch signing (base; signers get nonce, nonce+1, nonce+2). Decimal string.
    #[arg(long, env = "SIGNATURE_NONCE", default_value = "1")]
    pub signature_nonce: String,
}

