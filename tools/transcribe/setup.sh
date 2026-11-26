#!/bin/bash
# One-time setup of the offline transcriber for ATG ELN voice memos (macOS, Apple Silicon or Intel).
#   bash tools/transcribe/setup.sh          asks before installing or downloading anything
#   bash tools/transcribe/setup.sh --yes    no questions
# Installs with Homebrew, if missing: whisper-cpp (the transcriber) and ffmpeg (reads .m4a).
# Downloads, if missing: the speech model (1.6 GB) and a small silence detector (0.9 MB), each checked against a fixed SHA-256.
# Nothing is written inside the repository. Models go to ~/.cache/atg-eln/models (or $ATG_ELN_MODELS).
set -euo pipefail

MODELS="${ATG_ELN_MODELS:-$HOME/.cache/atg-eln/models}"
MODEL_NAME="ggml-large-v3-turbo.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo.bin"
MODEL_SHA="1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69"
MODEL_SIZE="1.6 GB"
VAD_NAME="ggml-silero-v5.1.2.bin"
VAD_URL="https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v5.1.2.bin"
VAD_SHA="29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf"
VAD_SIZE="0.9 MB"
YES="${1:-}"

confirm() {
  if [ "$YES" = "--yes" ]; then return 0; fi
  read -r -p "$1 [y/N] " answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ]
}

if [ "$(uname -s)" != "Darwin" ]; then echo "This setup is for macOS."; exit 1; fi
if ! command -v brew >/dev/null 2>&1; then echo "Homebrew is needed first: see https://brew.sh, then run this again."; exit 1; fi

NEEDED=()
command -v whisper-cli >/dev/null 2>&1 || NEEDED+=("whisper-cpp")
command -v ffmpeg >/dev/null 2>&1 || NEEDED+=("ffmpeg")
if [ "${#NEEDED[@]}" -gt 0 ]; then
  if confirm "Install with Homebrew: ${NEEDED[*]}?"; then brew install "${NEEDED[@]}"; else echo "Not installed. Stopping."; exit 1; fi
fi

# fetch <name> <url> <sha256> <size>: download to a temporary name, keep the file only if its checksum matches
fetch() {
  local name="$1" url="$2" sha="$3" size="$4" dest="$MODELS/$1" part="$MODELS/$1.part"
  if [ -f "$dest" ] && [ "$(shasum -a 256 "$dest" | cut -d' ' -f1)" = "$sha" ]; then echo "$name is already there and its checksum matches."; return 0; fi
  if ! confirm "Download $name ($size) from ${url%%/resolve/*} into $MODELS?"; then echo "Skipped $name."; return 1; fi
  mkdir -p "$MODELS"
  curl --location --fail --proto '=https' --proto-redir '=https' --tlsv1.2 --progress-bar --output "$part" "$url"
  if [ "$(shasum -a 256 "$part" | cut -d' ' -f1)" != "$sha" ]; then rm -f "$part"; echo "The checksum of $name did not match, so it was deleted. Nothing was installed."; return 1; fi
  mv "$part" "$dest"
  echo "$name is ready."
}

fetch "$MODEL_NAME" "$MODEL_URL" "$MODEL_SHA" "$MODEL_SIZE" || { echo "The speech model is required. Stopping."; exit 1; }
fetch "$VAD_NAME" "$VAD_URL" "$VAD_SHA" "$VAD_SIZE" || echo "Continuing without the silence detector (long recordings may pick up stray words in pauses)."

node "$(dirname "$0")/transcribe.mjs" check
echo "Setup finished."
