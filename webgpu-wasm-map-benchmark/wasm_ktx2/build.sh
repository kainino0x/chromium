#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$ROOT_DIR/build"
mkdir -p "$OUT_DIR"

# Locate Basis Universal transcoder + Zstd sources
# (e.g. `git clone --depth=1 https://github.com/BinomialLLC/basis_universal.git wasm_ktx2/basis_universal`).
BASIS_ROOT="${BASIS_ROOT:-$SCRIPT_DIR/basis_universal}"
if [[ ! -f "$BASIS_ROOT/transcoder/basisu_transcoder.cpp" ]]; then
  echo "Error: Basis Universal sources not found at $BASIS_ROOT." >&2
  echo "Clone https://github.com/BinomialLLC/basis_universal.git into wasm_ktx2/basis_universal or set BASIS_ROOT." >&2
  exit 1
fi

if ! command -v em++ >/dev/null 2>&1 || ! command -v emcc >/dev/null 2>&1; then
  echo "Error: Emscripten (emcc / em++) must be in PATH." >&2
  exit 1
fi

COMPILE_FLAGS=(
  -O3
  -msimd128
  -fno-exceptions
  -fno-strict-aliasing
  -DNDEBUG
  -Wno-version-check
  -Wno-implicit-fallthrough
  -Wno-unused-variable
  -Wno-unused-value
  -Wno-reorder
  -Wno-deprecated-builtins
  -I"$BASIS_ROOT"
  -I"$BASIS_ROOT/transcoder"
  -DBASISD_SUPPORT_KTX2=1
  -DBASISD_SUPPORT_KTX2_ZSTD=1
  -DBASISD_SUPPORT_UASTC=1
  -DBASISD_SUPPORT_BC7=1
  -DBASISD_SUPPORT_BC7_MODE5=1
  -DBASISD_SUPPORT_DXT1=1
  -DBASISD_SUPPORT_DXT5A=1
  -DBASISD_SUPPORT_ASTC=1
  -DBASISD_SUPPORT_ETC2_EAC_A8=1
  -DBASISD_SUPPORT_ETC2_EAC_RG11=1
  -DBASISD_SUPPORT_FXT1=0
  -DBASISD_SUPPORT_ATC=0
  -DBASISD_SUPPORT_PVRTC1=0
  -DBASISD_SUPPORT_PVRTC2=0
)

LINK_FLAGS=(
  -O3
  -msimd128
  -fno-exceptions
  -Wno-version-check
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sENVIRONMENT=web,worker,node
  -sFILESYSTEM=0
  -sINITIAL_MEMORY=134217728
  -sALLOW_MEMORY_GROWTH=1
  -sMAXIMUM_MEMORY=4294901760
  -sMALLOC=dlmalloc
  "-sEXPORTED_RUNTIME_METHODS=['wasmMemory']"
  "-sEXPORTED_FUNCTIONS=['_ktx2_init','_ktx2_alloc_slot','_ktx2_free_slot','_ktx2_ensure_input_buffer','_ktx2_get_header_info_ptr','_ktx2_inspect_header','_ktx2_compute_transcoded_byte_size','_ktx2_transcode_level0']"
)

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

emcc -c "$BASIS_ROOT/zstd/zstddeclib.c" "${COMPILE_FLAGS[@]}" -o "$WORK_DIR/zstddeclib.o"
em++ -c "$BASIS_ROOT/transcoder/basisu_transcoder.cpp" "${COMPILE_FLAGS[@]}" -o "$WORK_DIR/basisu_transcoder.o"
em++ \
  "$SCRIPT_DIR/ktx2_decoder.cpp" \
  "$WORK_DIR/basisu_transcoder.o" \
  "$WORK_DIR/zstddeclib.o" \
  "${COMPILE_FLAGS[@]}" \
  "${LINK_FLAGS[@]}" \
  -o "$OUT_DIR/ktx2_decoder.js"

ls -lh "$OUT_DIR/ktx2_decoder.js" "$OUT_DIR/ktx2_decoder.wasm"
