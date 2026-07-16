// llm_client.rs — provider-agnostic OpenAI-compatible chat client (D10).
// One HTTP client backs Remote, Ollama, and custom-local: they all speak
// the same `/chat/completions` shape, so provider identity is just a
// config value (base_url/model/needs_key), never a branch in this code.
//
// Deliberately does NOT fetch the API key itself — `complete()` takes an
// already-resolved `api_key: Option<&str>` so the mock-server unit tests
// below never touch the real Keychain. The `llm_complete` tauri::command
// at the bottom is the only place that bridges the two.

use crate::commands::provider_config::ProviderConfig;
use serde::{Deserialize, Serialize};
use std::time::Duration;

// T9 real-app testing (2026-07-15): a 120s timeout cut off a genuine local
// Ollama generation mid-stream — the paragraph-index prompt for a ~100-block
// document ran ~20k input tokens, and gemma4:latest on the test machine
// generates at ~48 tokens/s, needing well over two minutes for the full
// section+story output. 10 minutes gives real local hardware headroom for a
// large document without masking a genuinely hung request forever.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

/// OpenAI-compatible `response_format` — Ollama maps `json_object` to its
/// grammar-constrained `format: json` decoding; Cerebras supports it
/// natively. The synthesis contract (docs/prompts/engine-b-synthesis.md,
/// "Invocation settings") mandates JSON mode where the runtime supports it:
/// the prompt's "Output ONLY the JSON object" line is the fallback, not the
/// mechanism. A real T9 failure proved why — a long wild-document response
/// broke JSON syntax mid-output on all 3 attempts, which grammar-level
/// constraint makes impossible.
#[derive(Debug, Serialize)]
struct ResponseFormat {
    #[serde(rename = "type")]
    kind: &'static str,
}

/// Hard output ceiling sent with every request. A healthy synthesis payload
/// is ~1k tokens (largest observed: 1020 for a 4.4k-token doc), so 8k is
/// generous headroom — while a runaway generation (observed live 2026-07-16:
/// Cerebras gemma-4-31b emitted tokens to the provider's own 40k cap on all
/// 3 retry attempts, billed in full) now dies ~5× cheaper and faster. A
/// legitimate payload that ever grows past this truncates into invalid JSON,
/// which the parse→check→retry loop rejects VISIBLY — never a silent cap.
/// `max_tokens` (not `max_completion_tokens`) is the field both Ollama's
/// OpenAI-compat layer and Cerebras accept.
const MAX_OUTPUT_TOKENS: u32 = 8_000;

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    temperature: f32,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<ResponseFormat>,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Debug, Deserialize)]
struct ChatChoiceMessage {
    content: String,
}

/// Core HTTP call, provider-agnostic. `client` is injected so tests can use
/// a short-timeout client without slowing down the suite; production code
/// goes through `llm_complete` below, which builds one with `DEFAULT_TIMEOUT`.
pub async fn complete(
    client: &reqwest::Client,
    config: &ProviderConfig,
    api_key: Option<&str>,
    system_prompt: &str,
    user_message: &str,
    temperature: f32,
    json_mode: bool,
) -> Result<String, String> {
    if config.base_url.trim().is_empty() {
        return Err("No base URL configured for this provider — set one in Settings".to_string());
    }
    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let body = ChatRequest {
        model: &config.model,
        messages: vec![
            ChatMessage { role: "system", content: system_prompt },
            ChatMessage { role: "user", content: user_message },
        ],
        temperature,
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: json_mode.then_some(ResponseFormat { kind: "json_object" }),
    };

    let mut req = client.post(&url).json(&body);
    if let Some(key) = api_key {
        req = req.bearer_auth(key);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("request to {url} failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("provider returned HTTP {status}: {text}"));
    }

    let parsed: ChatResponse = resp
        .json()
        .await
        .map_err(|e| format!("provider response did not match the expected chat-completions shape: {e}"))?;

    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .ok_or_else(|| "provider returned zero choices".to_string())
}

/// Cancellation slot for the (single) in-flight generation. Real
/// cancellation, not just ignoring the result: `cancel()` wakes the
/// `tokio::select!` in `complete_cancellable`, which DROPS the reqwest
/// future — closing the HTTP connection. llama-server treats a dropped
/// connection as a task cancel and frees the GPU immediately (observed in
/// the user's own server log: `srv stop: cancel task` the moment a client
/// timeout dropped the connection). Without this, "Stop" only made the UI
/// look idle while Ollama kept generating to completion.
#[derive(Default)]
pub struct LlmCancelState(std::sync::Mutex<Option<std::sync::Arc<tokio::sync::Notify>>>);

impl LlmCancelState {
    /// Register a new in-flight request, superseding (cancelling) any prior
    /// one — the switchMap semantics the frontend already assumes.
    fn begin(&self) -> std::sync::Arc<tokio::sync::Notify> {
        let mut slot = self.0.lock().unwrap();
        if let Some(prev) = slot.take() {
            prev.notify_one();
        }
        let token = std::sync::Arc::new(tokio::sync::Notify::new());
        *slot = Some(token.clone());
        token
    }

    pub fn cancel(&self) {
        if let Some(token) = self.0.lock().unwrap().take() {
            // notify_one stores a permit if the waiter hasn't reached its
            // await yet — no lost-wakeup race with begin().
            token.notify_one();
        }
    }
}

/// `complete`, but racing against the cancel slot. On cancel the request
/// future is dropped (connection closed → provider aborts generation).
pub async fn complete_cancellable(
    client: &reqwest::Client,
    config: &ProviderConfig,
    api_key: Option<&str>,
    system_prompt: &str,
    user_message: &str,
    temperature: f32,
    json_mode: bool,
    cancel: &LlmCancelState,
) -> Result<String, String> {
    let token = cancel.begin();
    tokio::select! {
        res = complete(client, config, api_key, system_prompt, user_message, temperature, json_mode) => res,
        _ = token.notified() => Err("generation cancelled".to_string()),
    }
}

#[tauri::command]
pub async fn llm_complete(
    app: tauri::AppHandle,
    state: tauri::State<'_, LlmCancelState>,
    system_prompt: String,
    user_message: String,
    json_mode: Option<bool>,
    temperature: Option<f32>,
) -> Result<String, String> {
    let config = crate::commands::provider_config::get_provider_config(app.clone())?;
    let api_key = if config.kind.needs_key() {
        Some(crate::commands::secrets::get_api_key()?)
    } else {
        None
    };
    let client = reqwest::Client::builder()
        .timeout(DEFAULT_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    complete_cancellable(
        &client,
        &config,
        api_key.as_deref(),
        &system_prompt,
        &user_message,
        // Attempt 1 stays at 0.0 (grouping stability, per the synthesis
        // contract); the caller raises it on RETRIES only — a temp-0 model
        // re-fed a near-identical prompt repeats its mistake verbatim, so a
        // same-temperature retry is provably wasted compute.
        temperature.unwrap_or(0.0).clamp(0.0, 1.0),
        json_mode.unwrap_or(false),
        &state,
    )
    .await
}

/// User clicked Stop: drop the in-flight request so the provider actually
/// stops generating (GPU relief), instead of the frontend merely ignoring
/// a result that keeps computing in the background.
#[tauri::command]
pub fn cancel_llm_generation(state: tauri::State<'_, LlmCancelState>) {
    state.cancel();
}

/// Health check surfaced in Settings (§8.3): is Ollama up / is the key
/// accepted. A cheap one-token completion, not a dedicated endpoint — every
/// provider here already speaks chat-completions, nothing else is guaranteed.
#[tauri::command]
pub async fn probe_provider(app: tauri::AppHandle) -> Result<bool, String> {
    let config = crate::commands::provider_config::get_provider_config(app.clone())?;
    let api_key = if config.kind.needs_key() {
        match crate::commands::secrets::get_api_key() {
            Ok(k) => Some(k),
            Err(_) => return Ok(false),
        }
    } else {
        None
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(complete(&client, &config, api_key.as_deref(), "Health check.", "Say OK", 0.0, false)
        .await
        .is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::provider_config::ProviderKind;

    fn config_for(base_url: String) -> ProviderConfig {
        ProviderConfig { kind: ProviderKind::Remote, base_url, model: "test-model".to_string() }
    }

    fn ok_body() -> String {
        serde_json::json!({
            "choices": [{ "message": { "role": "assistant", "content": "hello from mock" } }]
        })
        .to_string()
    }

    #[tokio::test]
    async fn correct_url_joining_and_authorization_header_present_for_remote() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/chat/completions")
            .match_header("authorization", "Bearer test-key-123")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(ok_body())
            .create_async()
            .await;

        let client = reqwest::Client::new();
        let config = config_for(server.url());
        let result = complete(&client, &config, Some("test-key-123"), "sys", "user", 0.0, false).await;

        mock.assert_async().await;
        assert_eq!(result.unwrap(), "hello from mock");
    }

    #[tokio::test]
    async fn authorization_header_absent_for_local_providers() {
        let mut server = mockito::Server::new_async().await;
        // match_header with Matcher::Missing asserts the header is NOT sent.
        let mock = server
            .mock("POST", "/chat/completions")
            .match_header("authorization", mockito::Matcher::Missing)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(ok_body())
            .create_async()
            .await;

        let client = reqwest::Client::new();
        let mut config = config_for(server.url());
        config.kind = ProviderKind::Ollama;
        let result = complete(&client, &config, None, "sys", "user", 0.0, false).await;

        mock.assert_async().await;
        assert_eq!(result.unwrap(), "hello from mock");
    }

    #[tokio::test]
    async fn base_url_trailing_slash_does_not_produce_a_double_slash() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(ok_body())
            .create_async()
            .await;

        let client = reqwest::Client::new();
        let config = config_for(format!("{}/", server.url()));
        let result = complete(&client, &config, None, "sys", "user", 0.0, false).await;

        mock.assert_async().await;
        assert!(result.is_ok(), "trailing slash in base_url must not break URL joining");
    }

    #[tokio::test]
    async fn non_200_response_surfaces_status_and_body() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/chat/completions")
            .with_status(500)
            .with_body("internal provider error")
            .create_async()
            .await;

        let client = reqwest::Client::new();
        let config = config_for(server.url());
        let err = complete(&client, &config, None, "sys", "user", 0.0, false).await.unwrap_err();

        assert!(err.contains("500"), "error must surface the HTTP status: {err}");
        assert!(err.contains("internal provider error"), "error must surface the body: {err}");
    }

    #[tokio::test]
    async fn timeout_is_surfaced_as_an_error_not_a_hang() {
        // A raw listener that accepts the TCP connection and then never
        // writes a response — reqwest's own client-side timeout is the
        // only thing that can end this request. Avoids relying on
        // mockito's response-delay semantics, which (as of 1.7) send
        // status/headers before any body-writer closure runs, so a sleep
        // inside `with_chunked_body` doesn't delay the response the way a
        // real slow server would.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            // Hold the connection open (never read/write) until the test's
            // client times out and drops it.
            let _ = listener.accept();
            std::thread::sleep(Duration::from_secs(5));
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(100))
            .build()
            .unwrap();
        let config = config_for(format!("http://{addr}"));
        let err = complete(&client, &config, None, "sys", "user", 0.0, false).await.unwrap_err();

        assert!(err.contains("failed") || err.to_lowercase().contains("time"),
            "expected a timeout-shaped error, got: {err}");
    }

    #[tokio::test]
    async fn json_mode_sends_response_format_and_default_omits_it() {
        let mut server = mockito::Server::new_async().await;
        let with_format = server
            .mock("POST", "/chat/completions")
            .match_body(mockito::Matcher::PartialJsonString(
                r#"{"response_format":{"type":"json_object"}}"#.to_string(),
            ))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(ok_body())
            .expect(1)
            .create_async()
            .await;

        let client = reqwest::Client::new();
        let config = config_for(server.url());
        complete(&client, &config, None, "sys", "user", 0.0, true).await.unwrap();
        with_format.assert_async().await;

        // Default (probe path): the key must be ABSENT, not null — some
        // providers reject response_format: null outright. Exact JSON
        // equality proves absence: any extra key would fail the match.
        let without_format = server
            .mock("POST", "/chat/completions")
            .match_body(mockito::Matcher::Json(serde_json::json!({
                "model": "test-model",
                "messages": [
                    {"role": "system", "content": "sys"},
                    {"role": "user", "content": "user"}
                ],
                "temperature": 0.0,
                "max_tokens": 8000
            })))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(ok_body())
            .expect(1)
            .create_async()
            .await;

        complete(&client, &config, None, "sys", "user", 0.0, false).await.unwrap();
        without_format.assert_async().await;
    }

    #[tokio::test]
    async fn cancel_terminates_an_in_flight_request_promptly() {
        // A listener that accepts and then never responds — only
        // cancellation (dropping the request future) can end this quickly;
        // the client itself has NO timeout here.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            // Bind the stream to a NAMED variable — `let _ =` drops (closes)
            // the accepted socket immediately, failing the request outright
            // instead of leaving it hanging for cancel to terminate.
            let _conn = listener.accept();
            std::thread::sleep(Duration::from_secs(30));
        });

        let cancel = std::sync::Arc::new(LlmCancelState::default());
        let cancel2 = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel2.cancel();
        });

        let client = reqwest::Client::new();
        let config = config_for(format!("http://{addr}"));
        let start = std::time::Instant::now();
        let err = complete_cancellable(&client, &config, None, "sys", "user", 0.0, false, &cancel)
            .await
            .unwrap_err();

        assert!(err.contains("cancelled"), "got: {err}");
        assert!(start.elapsed() < Duration::from_secs(5),
            "cancel must terminate the request promptly, took {:?}", start.elapsed());
    }

    #[tokio::test]
    async fn a_new_request_supersedes_and_cancels_the_previous_one() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            // Accept both connections, respond to neither.
            let a = listener.accept();
            let b = listener.accept();
            std::thread::sleep(Duration::from_secs(30));
            drop((a, b));
        });

        let cancel = std::sync::Arc::new(LlmCancelState::default());
        let client = reqwest::Client::new();
        let config = config_for(format!("http://{addr}"));

        let first = {
            let (cancel, client, config) = (cancel.clone(), client.clone(), config.clone());
            tokio::spawn(async move {
                complete_cancellable(&client, &config, None, "sys", "user", 0.0, false, &cancel).await
            })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Starting a second request must cancel the first (switchMap semantics)…
        let second = {
            let (cancel, client, config) = (cancel.clone(), client.clone(), config.clone());
            tokio::spawn(async move {
                complete_cancellable(&client, &config, None, "sys", "user", 0.0, false, &cancel).await
            })
        };
        let first_err = first.await.unwrap().unwrap_err();
        assert!(first_err.contains("cancelled"), "got: {first_err}");

        // …and an explicit cancel ends the second.
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel.cancel();
        let second_err = second.await.unwrap().unwrap_err();
        assert!(second_err.contains("cancelled"), "got: {second_err}");
    }

    #[tokio::test]
    async fn empty_base_url_fails_fast_without_a_network_call() {
        let client = reqwest::Client::new();
        let config = config_for(String::new());
        let err = complete(&client, &config, None, "sys", "user", 0.0, false).await.unwrap_err();
        assert!(err.contains("No base URL"), "got: {err}");
    }
}
