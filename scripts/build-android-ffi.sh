#!/usr/bin/env bash
set -euo pipefail

# Build the Android cdylib for multiple ABIs and copy to Capacitor Android jniLibs
CRATE_MANIFEST="frontend/src-tauri/android-ffi/Cargo.toml"
CRATE_DIR="frontend/src-tauri/android-ffi"
CRATE_NAME="yupify_android"
NDK_API=21

echo "Installing cargo-ndk (if missing)"
cargo install cargo-ndk --locked || true


echo "Building for Android ABIs (running inside crate dir)"
pushd "$CRATE_DIR" > /dev/null
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86 --platform $NDK_API build --release
popd > /dev/null

# Map targets -> ABIs
declare -A map
map[aarch64-linux-android]=arm64-v8a
map[armv7-linux-androideabi]=armeabi-v7a
map[i686-linux-android]=x86

for target in "aarch64-linux-android" "armv7-linux-androideabi" "i686-linux-android"; do
  abi=${map[$target]}
  src="$CRATE_DIR/target/$target/release/lib${CRATE_NAME}.so"
  dest="frontend/android/app/src/main/jniLibs/$abi"
  if [ -f "$src" ]; then
    mkdir -p "$dest"
    cp "$src" "$dest/lib${CRATE_NAME}.so"
    echo "Copied $src -> $dest/"
  else
    echo "Warning: $src not found"
  fi
done

echo "Done building Android native library."
