#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use once_cell::sync::Lazy;
use serde::Deserialize;
use std::sync::Mutex;

use discord_rich_presence::{
  activity::{Activity, Assets, Timestamps},
  DiscordIpc,
  DiscordIpcClient,
};

static RPC_CLIENT_ID: Lazy<String> = Lazy::new(|| {
  std::env::var("DISCORD_CLIENT_ID").unwrap_or_default()
});

static RPC_CLIENT: Lazy<Mutex<Option<DiscordIpcClient>>> = Lazy::new(|| Mutex::new(None));

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityPayload {
  details: Option<String>,
  state: Option<String>,
  start_timestamp: Option<i64>,
  end_timestamp: Option<i64>,
  large_image: Option<String>,
  large_text: Option<String>,
  small_image: Option<String>,
  small_text: Option<String>,
}

fn with_rpc<F, R>(f: F) -> Result<R, String>
where
  F: FnOnce(&mut DiscordIpcClient) -> Result<R, String>,
{
  let client_id = RPC_CLIENT_ID.as_str();
  if client_id.is_empty() {
    return Err("DISCORD_CLIENT_ID no configurado".to_string());
  }

  let mut guard = RPC_CLIENT
    .lock()
    .map_err(|_| "RPC lock en mal estado".to_string())?;

  if guard.is_none() {
    let mut client = DiscordIpcClient::new(client_id)
      .map_err(|err| format!("RPC init error: {err}"))?;
    client
      .connect()
      .map_err(|err| format!("RPC connect error: {err}"))?;
    *guard = Some(client);
  }

  let client = guard
    .as_mut()
    .ok_or_else(|| "RPC client no disponible".to_string())?;
  f(client)
}

#[tauri::command]
fn rpc_set_activity(payload: ActivityPayload) -> Result<(), String> {
  with_rpc(|client| {
    let mut activity = Activity::new();

    if let Some(details) = payload.details.as_ref() {
      if !details.is_empty() {
        activity = activity.details(details);
      }
    }

    if let Some(state) = payload.state.as_ref() {
      if !state.is_empty() {
        activity = activity.state(state);
      }
    }

    if payload.start_timestamp.is_some() || payload.end_timestamp.is_some() {
      let mut timestamps = Timestamps::new();
      if let Some(start) = payload.start_timestamp {
        timestamps = timestamps.start(start);
      }
      if let Some(end) = payload.end_timestamp {
        timestamps = timestamps.end(end);
      }
      activity = activity.timestamps(timestamps);
    }

    if payload.large_image.is_some()
      || payload.large_text.is_some()
      || payload.small_image.is_some()
      || payload.small_text.is_some()
    {
      let mut assets = Assets::new();
      if let Some(large_image) = payload.large_image.as_ref() {
        if !large_image.is_empty() {
          assets = assets.large_image(large_image);
        }
      }
      if let Some(large_text) = payload.large_text.as_ref() {
        if !large_text.is_empty() {
          assets = assets.large_text(large_text);
        }
      }
      if let Some(small_image) = payload.small_image.as_ref() {
        if !small_image.is_empty() {
          assets = assets.small_image(small_image);
        }
      }
      if let Some(small_text) = payload.small_text.as_ref() {
        if !small_text.is_empty() {
          assets = assets.small_text(small_text);
        }
      }
      activity = activity.assets(assets);
    }

    client
      .set_activity(activity)
      .map_err(|err| format!("RPC set_activity error: {err}"))?;
    Ok(())
  })
}

#[tauri::command]
fn rpc_clear_activity() -> Result<(), String> {
  with_rpc(|client| {
    client
      .clear_activity()
      .map_err(|err| format!("RPC clear_activity error: {err}"))?;
    Ok(())
  })
}

#[tauri::command]
fn rpc_disconnect() -> Result<(), String> {
  let mut guard = RPC_CLIENT
    .lock()
    .map_err(|_| "RPC lock en mal estado".to_string())?;
  if let Some(mut client) = guard.take() {
    let _ = client.close();
  }
  Ok(())
}

fn main() {
  dotenvy::dotenv().ok();
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      rpc_set_activity,
      rpc_clear_activity,
      rpc_disconnect
    ])
    .run(tauri::generate_context!())
    .expect("error al ejecutar Tauri");
}
