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
}

#[derive(Args, Debug, Clone)]
pub struct BatchArgs {
    #[command(flatten)]
    pub bridge: BridgeCallArgs,

    /// Max nonce for signature scanning.
    #[arg(long, env = "SIGNATURE_MAX_NONCE", default_value = "256")]
    pub signature_max_nonce: u64,
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
