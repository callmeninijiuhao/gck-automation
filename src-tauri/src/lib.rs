use std::collections::HashMap;
use std::process::Command;

#[cfg(target_os = "macos")]
fn get_macos_system_proxy() -> Option<reqwest::Proxy> {
    let output = Command::new("scutil").arg("--proxy").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    
    let mut http_enabled = false;
    let mut http_proxy = String::new();
    let mut http_port = String::new();
    
    let mut https_enabled = false;
    let mut https_proxy = String::new();
    let mut https_port = String::new();
    
    let mut socks_enabled = false;
    let mut socks_proxy = String::new();
    let mut socks_port = String::new();

    for line in stdout.lines() {
        let line = line.trim();
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() < 2 {
            continue;
        }
        let key = parts[0].trim();
        let val = parts[1].trim();

        if key == "HTTPEnable" {
            http_enabled = val == "1";
        } else if key == "HTTPProxy" {
            http_proxy = val.to_string();
        } else if key == "HTTPPort" {
            http_port = val.to_string();
        } else if key == "HTTPSEnable" {
            https_enabled = val == "1";
        } else if key == "HTTPSProxy" {
            https_proxy = val.to_string();
        } else if key == "HTTPSPort" {
            https_port = val.to_string();
        } else if key == "SOCKSEnable" {
            socks_enabled = val == "1";
        } else if key == "SOCKSProxy" {
            socks_proxy = val.to_string();
        } else if key == "SOCKSPort" {
            socks_port = val.to_string();
        }
    }

    if https_enabled && !https_proxy.is_empty() && !https_port.is_empty() {
        let proxy_url = format!("http://{}:{}", https_proxy, https_port);
        reqwest::Proxy::https(&proxy_url).ok()
    } else if http_enabled && !http_proxy.is_empty() && !http_port.is_empty() {
        let proxy_url = format!("http://{}:{}", http_proxy, http_port);
        reqwest::Proxy::http(&proxy_url).ok()
    } else if socks_enabled && !socks_proxy.is_empty() && !socks_port.is_empty() {
        let proxy_url = format!("socks5://{}:{}", socks_proxy, socks_port);
        reqwest::Proxy::all(&proxy_url).ok()
    } else {
        None
    }
}

#[tauri::command]
async fn native_fetch(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<String, String> {
    let mut builder = reqwest::Client::builder();

    #[cfg(target_os = "macos")]
    if let Some(proxy) = get_macos_system_proxy() {
        builder = builder.proxy(proxy);
    }

    let client = builder.build().map_err(|e| e.to_string())?;
    let mut request = match method.to_uppercase().as_str() {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };

    for (k, v) in headers {
        request = request.header(k, v);
    }

    if let Some(b) = body {
        request = request.body(b);
    }

    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }

    Ok(text)
}

// ─────────────────────────────────────────────
// Sending credentials embedded at build time from src-tauri/.build-secrets.env
// (gitignored). Empty when the file was absent during the build — the app then
// falls back to the in-app Sending Settings.
// ─────────────────────────────────────────────
const EMBED_SMTP_HOST: &str = match option_env!("EMBED_SMTP_HOST") {
    Some(v) => v,
    None => "",
};
const EMBED_SMTP_PORT: &str = match option_env!("EMBED_SMTP_PORT") {
    Some(v) => v,
    None => "",
};
const EMBED_EMAIL_USER: &str = match option_env!("EMBED_EMAIL_USER") {
    Some(v) => v,
    None => "",
};
const EMBED_EMAIL_PASSWORD: &str = match option_env!("EMBED_EMAIL_PASSWORD") {
    Some(v) => v,
    None => "",
};
const EMBED_SLACK_BOT_TOKEN: &str = match option_env!("EMBED_SLACK_BOT_TOKEN") {
    Some(v) => v,
    None => "",
};
// Looker auto-fetch: the channel Looker posts the daily TSV to, and the bot token
// with files:read on it. Token falls back to EMBED_SLACK_BOT_TOKEN when its own is unset.
const EMBED_LOOKER_SLACK_BOT_TOKEN: &str = match option_env!("EMBED_LOOKER_SLACK_BOT_TOKEN") {
    Some(v) => v,
    None => "",
};
const EMBED_LOOKER_SLACK_CHANNEL: &str = match option_env!("EMBED_LOOKER_SLACK_CHANNEL") {
    Some(v) => v,
    None => "",
};
// Capacity Monitoring auto-fetch: the channel Helix posts the daily Capacity Monitor CSV
// to, and a bot token with files:read. Token falls back to EMBED_SLACK_BOT_TOKEN when unset.
const EMBED_CAPACITY_SLACK_CHANNEL: &str = match option_env!("EMBED_CAPACITY_SLACK_CHANNEL") {
    Some(v) => v,
    None => "",
};
const EMBED_CAPACITY_SLACK_BOT_TOKEN: &str = match option_env!("EMBED_CAPACITY_SLACK_BOT_TOKEN") {
    Some(v) => v,
    None => "",
};
// Brain LLM (AI narrative): an API key for the OpenAI-compatible Brain endpoint plus which
// instance it targets ("stage" or "prod"). The key stays in Rust — never reaches the frontend.
const EMBED_BRAIN_LLM_API_KEY: &str = match option_env!("EMBED_BRAIN_LLM_API_KEY") {
    Some(v) => v,
    None => "",
};
const EMBED_BRAIN_LLM_ENV: &str = match option_env!("EMBED_BRAIN_LLM_ENV") {
    Some(v) => v,
    None => "stage",
};

/// Tells the frontend which credentials are baked into this build,
/// so it can hide the Sending Settings card. Never returns secret values.
#[tauri::command]
fn get_send_config() -> serde_json::Value {
    serde_json::json!({
        "emailEmbedded": !EMBED_EMAIL_USER.is_empty() && !EMBED_EMAIL_PASSWORD.is_empty(),
        "slackEmbedded": !EMBED_SLACK_BOT_TOKEN.is_empty(),
    })
}

/// Send an email via SMTP (STARTTLS, e.g. Office365) with an optional CSV attachment.
/// Uses build-time embedded credentials when present; otherwise the values
/// passed from the in-app Sending Settings.
#[tauri::command]
async fn send_email(
    smtp_host: String,
    smtp_port: u16,
    email_user: String,
    email_password: String,
    recipients: Vec<String>,
    subject: String,
    html: String,
    csv: Option<String>,
    filename: Option<String>,
) -> Result<String, String> {
    use lettre::message::{header::ContentType, Attachment, Mailbox, Message, MultiPart, SinglePart};
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};

    // Prefer embedded credentials; fall back to caller-provided settings.
    let (email_user, email_password) = if !EMBED_EMAIL_USER.is_empty() && !EMBED_EMAIL_PASSWORD.is_empty() {
        (EMBED_EMAIL_USER.to_string(), EMBED_EMAIL_PASSWORD.to_string())
    } else {
        (email_user, email_password)
    };
    let smtp_host = if !EMBED_SMTP_HOST.is_empty() {
        EMBED_SMTP_HOST.to_string()
    } else if smtp_host.is_empty() {
        "smtp.office365.com".to_string()
    } else {
        smtp_host
    };
    let smtp_port: u16 = if !EMBED_SMTP_PORT.is_empty() {
        EMBED_SMTP_PORT.parse().unwrap_or(587)
    } else if smtp_port == 0 {
        587
    } else {
        smtp_port
    };

    if email_user.is_empty() || email_password.is_empty() {
        return Err("Email credentials not configured (neither embedded at build time nor provided in Sending Settings)".to_string());
    }
    if recipients.is_empty() {
        return Err("No recipients provided".to_string());
    }

    let from: Mailbox = email_user
        .parse()
        .map_err(|e| format!("Invalid sender address: {e}"))?;

    let mut builder = Message::builder().from(from).subject(subject);
    for r in &recipients {
        builder = builder.to(r
            .parse()
            .map_err(|e| format!("Invalid recipient \"{r}\": {e}"))?);
    }

    let html_part = SinglePart::html(html);
    let body = if let Some(csv_data) = csv {
        let attachment = Attachment::new(filename.unwrap_or_else(|| "report.csv".to_string()))
            .body(
                csv_data.into_bytes(),
                ContentType::parse("text/csv").map_err(|e| e.to_string())?,
            );
        MultiPart::mixed().singlepart(html_part).singlepart(attachment)
    } else {
        MultiPart::mixed().singlepart(html_part)
    };

    let email = builder.multipart(body).map_err(|e| e.to_string())?;

    let mailer = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&smtp_host)
        .map_err(|e| format!("SMTP config error: {e}"))?
        .port(smtp_port)
        .credentials(Credentials::new(email_user, email_password))
        .build();

    mailer
        .send(email)
        .await
        .map_err(|e| format!("SMTP send failed: {e}"))?;

    Ok(recipients.join(", "))
}

/// Post a message to Slack via chat.postMessage. Uses the build-time embedded
/// bot token when present, otherwise the token passed from Sending Settings.
/// The token never reaches the frontend when embedded.
#[tauri::command]
async fn send_slack(
    channel: String,
    blocks: serde_json::Value,
    text: String,
    token: Option<String>,
) -> Result<String, String> {
    let token = if !EMBED_SLACK_BOT_TOKEN.is_empty() {
        EMBED_SLACK_BOT_TOKEN.to_string()
    } else {
        token.unwrap_or_default()
    };
    if token.is_empty() {
        return Err("Slack bot token not configured (neither embedded at build time nor provided in Sending Settings)".to_string());
    }

    let mut builder = reqwest::Client::builder();
    #[cfg(target_os = "macos")]
    if let Some(proxy) = get_macos_system_proxy() {
        builder = builder.proxy(proxy);
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let payload = serde_json::json!({
        "channel": channel,
        "blocks": blocks,
        "text": text,
    });

    let response = client
        .post("https://slack.com/api/chat.postMessage")
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json; charset=utf-8")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Slack request failed: {e}"))?;

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Slack response parse failed: {e}"))?;

    if body["ok"].as_bool() == Some(true) {
        Ok("ok".to_string())
    } else {
        Err(format!(
            "Slack API error: {}",
            body["error"].as_str().unwrap_or("unknown")
        ))
    }
}

/// Non-secret Looker config for the frontend: which channel to read, and whether a
/// token is available so the "Fetch latest from Slack" button can be enabled. No secrets.
#[tauri::command]
fn get_looker_config() -> serde_json::Value {
    serde_json::json!({
        "channel": EMBED_LOOKER_SLACK_CHANNEL,
        "hasToken": !EMBED_LOOKER_SLACK_BOT_TOKEN.is_empty() || !EMBED_SLACK_BOT_TOKEN.is_empty(),
    })
}

/// GET a Slack Web API / file URL using the embedded Looker token, injected here so the
/// token never reaches the frontend. Same success/error shape as native_fetch.
#[tauri::command]
async fn looker_fetch(url: String) -> Result<String, String> {
    let token = if !EMBED_LOOKER_SLACK_BOT_TOKEN.is_empty() {
        EMBED_LOOKER_SLACK_BOT_TOKEN.to_string()
    } else {
        EMBED_SLACK_BOT_TOKEN.to_string()
    };
    if token.is_empty() {
        return Err("Looker Slack token not configured (embed EMBED_LOOKER_SLACK_BOT_TOKEN at build time)".to_string());
    }

    let mut builder = reqwest::Client::builder();
    #[cfg(target_os = "macos")]
    if let Some(proxy) = get_macos_system_proxy() {
        builder = builder.proxy(proxy);
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }
    Ok(text)
}

/// Non-secret Capacity config for the frontend: which channel to read + whether a token
/// is available (so the fetch button can be enabled). No secrets.
#[tauri::command]
fn get_capacity_config() -> serde_json::Value {
    serde_json::json!({
        "channel": EMBED_CAPACITY_SLACK_CHANNEL,
        "hasToken": !EMBED_CAPACITY_SLACK_BOT_TOKEN.is_empty() || !EMBED_SLACK_BOT_TOKEN.is_empty(),
    })
}

/// GET a Slack URL using the embedded Capacity token, injected here so the token never
/// reaches the frontend. Same success/error shape as looker_fetch.
#[tauri::command]
async fn capacity_fetch(url: String) -> Result<String, String> {
    let token = if !EMBED_CAPACITY_SLACK_BOT_TOKEN.is_empty() {
        EMBED_CAPACITY_SLACK_BOT_TOKEN.to_string()
    } else {
        EMBED_SLACK_BOT_TOKEN.to_string()
    };
    if token.is_empty() {
        return Err("Capacity Slack token not configured (embed EMBED_CAPACITY_SLACK_BOT_TOKEN at build time)".to_string());
    }

    let mut builder = reqwest::Client::builder();
    #[cfg(target_os = "macos")]
    if let Some(proxy) = get_macos_system_proxy() {
        builder = builder.proxy(proxy);
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }
    Ok(text)
}

/// Non-secret LLM config for the frontend: whether a Brain key is embedded + which instance
/// (stage/prod) it targets. No secrets.
#[tauri::command]
fn get_llm_config() -> serde_json::Value {
    serde_json::json!({
        "hasKey": !EMBED_BRAIN_LLM_API_KEY.is_empty(),
        "environment": EMBED_BRAIN_LLM_ENV,
    })
}

/// POST an OpenAI-compatible chat-completions request to `url` with the raw JSON `body`,
/// using the embedded Brain key injected here so the key never reaches the frontend.
#[tauri::command]
async fn llm_complete(url: String, body: String) -> Result<String, String> {
    if EMBED_BRAIN_LLM_API_KEY.is_empty() {
        return Err("Brain LLM key not configured (embed EMBED_BRAIN_LLM_API_KEY at build time)".to_string());
    }

    let mut builder = reqwest::Client::builder();
    #[cfg(target_os = "macos")]
    if let Some(proxy) = get_macos_system_proxy() {
        builder = builder.proxy(proxy);
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", EMBED_BRAIN_LLM_API_KEY))
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }
    Ok(text)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            native_fetch,
            send_email,
            send_slack,
            get_send_config,
            get_looker_config,
            looker_fetch,
            get_capacity_config,
            capacity_fetch,
            get_llm_config,
            llm_complete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
