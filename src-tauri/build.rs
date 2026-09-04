use std::fs;
use std::path::Path;

/// Reads src-tauri/.build-secrets.env (gitignored) at compile time and embeds
/// the values into the binary via rustc-env, so end users never see or
/// configure sending credentials. If the file is absent, nothing is embedded
/// and the app falls back to the in-app Sending Settings card.
fn embed_build_secrets() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(".build-secrets.env");
    println!("cargo:rerun-if-changed={}", path.display());

    let allowed = [
        "EMBED_SMTP_HOST",
        "EMBED_SMTP_PORT",
        "EMBED_EMAIL_USER",
        "EMBED_EMAIL_PASSWORD",
        "EMBED_SLACK_BOT_TOKEN",
        // Looker Slack auto-fetch (Top Bundle) — must match the option_env! keys in lib.rs.
        "EMBED_LOOKER_SLACK_CHANNEL",
        "EMBED_LOOKER_SLACK_BOT_TOKEN",
    ];

    if let Ok(content) = fs::read_to_string(&path) {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim();
                if allowed.contains(&key) {
                    println!("cargo:rustc-env={}={}", key, value.trim());
                }
            }
        }
    }
}

fn main() {
    embed_build_secrets();
    tauri_build::build()
}
