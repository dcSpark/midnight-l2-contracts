use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::bridge::abi;

const MOCK_BATCH_DIR: &str = ".mock-batches";
const MOCK_BATCH_FILENAME: &str = "latest.json";

fn latest_mock_batch_path() -> PathBuf {
    PathBuf::from(MOCK_BATCH_DIR).join(MOCK_BATCH_FILENAME)
}

pub fn write_latest_mock_batch(batch: &abi::BatchPublicDataV1Full) -> Result<()> {
    let path = latest_mock_batch_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create mock batch directory {}", parent.display()))?;
    }
    let payload = serde_json::to_string_pretty(batch).context("failed to serialize mock batch json")?;
    let mut tmp_path = path.clone();
    tmp_path.set_extension("json.tmp");
    std::fs::write(&tmp_path, payload)
        .with_context(|| format!("failed to write {}", tmp_path.display()))?;
    std::fs::rename(&tmp_path, &path).with_context(|| {
        format!(
            "failed to atomically move {} to {}",
            tmp_path.display(),
            path.display()
        )
    })?;
    println!("Wrote mock batch file: {}", path.display());
    Ok(())
}

pub fn read_latest_mock_batch() -> Result<abi::BatchPublicDataV1Full> {
    let path = latest_mock_batch_path();
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("failed to read mock batch file {}", path.display()))?;
    let batch = serde_json::from_str::<abi::BatchPublicDataV1Full>(&raw)
        .with_context(|| format!("failed to parse mock batch json {}", path.display()))?;
    Ok(batch)
}
