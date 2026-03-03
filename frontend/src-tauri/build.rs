use std::path::PathBuf;

fn has_client_id() -> bool {
  std::env::var("DISCORD_CLIENT_ID")
    .ok()
    .and_then(|value| {
      let trimmed = value.trim();
      if trimmed.is_empty() {
        None
      } else {
        Some(trimmed.to_string())
      }
    })
    .is_some()
}

fn load_env() {
  let _ = dotenvy::dotenv();
  if has_client_id() {
    return;
  }

  if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
    let manifest_path = PathBuf::from(manifest_dir);
    let parent = manifest_path.parent().unwrap_or(&manifest_path);
    let grandparent = parent.parent().unwrap_or(parent);
    let candidates = [
      manifest_path.join(".env"),
      parent.join(".env"),
      grandparent.join(".env"),
    ];
    for path in candidates {
      println!("cargo:rerun-if-changed={}", path.display());
      if !path.exists() {
        continue;
      }
      let _ = dotenvy::from_path(&path);
      if has_client_id() {
        break;
      }
    }
  }
  println!("cargo:rerun-if-env-changed=DISCORD_CLIENT_ID");
}

fn main() {
  load_env();
  if let Ok(value) = std::env::var("DISCORD_CLIENT_ID") {
    let trimmed = value.trim();
    if !trimmed.is_empty() {
      println!("cargo:rustc-env=DISCORD_CLIENT_ID={}", trimmed);
    }
  }
  tauri_build::build()
}
