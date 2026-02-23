use anyhow::Result;
use clap::Parser;

mod bridge;
mod cli;
mod commands;
mod executor_client;
mod ts_cli;

pub use cli::{BatchArgs, BridgeCallArgs, DecodeArgs, DepositArgs};
pub use bridge::ledger::{BridgeLedger, RollupLedger};

#[tokio::main]
async fn main() -> Result<()> {
    // Load .env from current dir or parent (bridge-cli) so BRIDGE_CONTRACT_ADDRESS etc. are set.
    dotenvy::dotenv().ok();
    dotenvy::from_path("../.env").ok();

    let cli = cli::Cli::parse();

    match cli.command {
        cli::CommandKind::Decode(args) => commands::decode::run(args).await,
        cli::CommandKind::CommitBatch(args) => commands::commit_batch::run(args).await,
        cli::CommandKind::FinalizeBatch(args) => commands::finalize_batch::run(args).await,
        cli::CommandKind::Deposit(args) => commands::deposit::run(args).await,
        cli::CommandKind::SetVerifierSet(args) => commands::set_verifier_set::run(args).await,
        cli::CommandKind::RelayWithdrawNightWithProof(args) => {
            commands::relay_withdraw_night_with_proof::run(args).await
        }
        cli::CommandKind::ClaimL1Withdrawal(args) => commands::claim_l1_withdrawal::run(args).await,
        cli::CommandKind::TestWithdraw(args) => commands::test_withdraw::run(args).await,
    }
}
