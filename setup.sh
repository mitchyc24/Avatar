#!/usr/bin/env bash
# Downloads the third-party files Avatar Call needs, pinned and checksum-verified:
#   - MediaPipe face tracking (JS bundle, WebAssembly runtime, face model)  -> public/vendor/mediapipe
#   - cloudflared, only with --tunnel (for ./avatar --share)                -> bin/cloudflared
set -euo pipefail
cd "$(dirname "$0")"

MP_VERSION=1.0.1
MP_BASE="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
CF_VERSION=2026.9.3

fetch() { # url dest sha256
  local url=$1 dest=$2 sum=$3
  if [[ -f $dest ]] && echo "$sum  $dest" | sha256sum --quiet -c - 2>/dev/null; then
    return
  fi
  echo "Downloading $(basename "$dest")..."
  mkdir -p "$(dirname "$dest")"
  curl -fL --retry 3 -o "$dest.part" "$url"
  if ! echo "$sum  $dest.part" | sha256sum --quiet -c -; then
    rm -f "$dest.part"
    echo "Checksum mismatch for $url" >&2
    exit 1
  fi
  mv "$dest.part" "$dest"
}

V=public/vendor/mediapipe
fetch "$MP_BASE/vision_bundle.mjs" $V/vision_bundle.mjs d885630c297c0b20b1fe86096cb06291c4c8080876f27852e724f24ac603713f
fetch "$MP_BASE/wasm/vision_wasm_internal.js" $V/wasm/vision_wasm_internal.js e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73
fetch "$MP_BASE/wasm/vision_wasm_internal.wasm" $V/wasm/vision_wasm_internal.wasm 8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886
fetch "$MP_BASE/wasm/vision_wasm_nosimd_internal.js" $V/wasm/vision_wasm_nosimd_internal.js e81d715a3d42cc3373602eb2f7aff795d164934db680e32496b65dab537f9658
fetch "$MP_BASE/wasm/vision_wasm_nosimd_internal.wasm" $V/wasm/vision_wasm_nosimd_internal.wasm a28483cd42e74e855bf5ebdb6b40d9b66a5b49e35e95020bc97669e6822a3192
fetch "$MODEL_URL" $V/face_landmarker.task 64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff

if [[ ${1:-} == --tunnel ]]; then
  case $(uname -m) in
    x86_64) arch=amd64 sum=77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2 ;;
    aarch64) arch=arm64 sum=aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d ;;
    *) echo "No pinned cloudflared build for $(uname -m); install cloudflared yourself." >&2; exit 1 ;;
  esac
  fetch "https://github.com/cloudflare/cloudflared/releases/download/${CF_VERSION}/cloudflared-linux-${arch}" bin/cloudflared $sum
  chmod +x bin/cloudflared
fi

echo "Setup complete."
