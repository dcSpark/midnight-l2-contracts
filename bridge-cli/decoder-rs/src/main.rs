use anyhow::Result;
use clap::Parser;
use decoder_rs::{cli, commands, CommandKind};

#[tokio::main]
async fn main() -> Result<()> {
    // Load .env from current dir or parent (bridge-cli) so BRIDGE_CONTRACT_ADDRESS etc. are set.
    dotenvy::dotenv().ok();
    dotenvy::from_path("../.env").ok();

    let cli = cli::Cli::parse();

    match cli.command {
        CommandKind::Decode(args) => commands::decode::run(args).await,
        CommandKind::CommitBatch(args) => commands::commit_batch::run(args).await,
        CommandKind::FinalizeBatch(args) => commands::finalize_batch::run(args).await,
        CommandKind::Deposit(args) => commands::deposit::run(args).await,
        CommandKind::SetVerifierSet(args) => commands::set_verifier_set::run(args).await,
        CommandKind::RelayWithdrawNightWithProof(args) => {
            commands::relay_withdraw_night_with_proof::run(args).await
        }
        CommandKind::ClaimL1Withdrawal(args) => commands::claim_l1_withdrawal::run(args).await,
        CommandKind::TestWithdraw(args) => commands::test_withdraw::run(args).await,
        CommandKind::TestCost(args) => commands::test_cost::run(args).await,
    }
}
