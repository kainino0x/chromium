// Thin C++ WebAssembly wrapper around Basis Universal's ktx2_transcoder.
//
// Unlike stock Embind basis_wrappers.cpp (which transcodes into a temporary
// basisu::vector<uint8_t> and then JS-copies into a destination TypedArray),
// ktx2_transcode_level0 writes decoded blocks/texels directly into a
// caller-supplied Wasm linear-memory address `dst_ptr`.
//
// In the mmap prototype path, `dst_ptr` points to a 64 KiB-aligned range of
// WebAssembly.Memory backed directly by a mapped WebGPU GPUBuffer via
// GPUBuffer.getMMapDescriptor(0, size).map(wasmMemory, dst_ptr), eliminating
// any intermediate Wasm-heap -> GPUBuffer copy.

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <unordered_map>

#include <emscripten/emscripten.h>

#include "transcoder/basisu_transcoder.h"

namespace {

// 64 KiB matches Wasm page size and satisfies both 4 KiB/16 KiB POSIX page
// alignment and Windows 64 KiB sandbox VirtualAddressSpace granularity.
constexpr uintptr_t kSlotAlignment = 65536;

bool g_initialized = false;
basist::ktx2_transcoder g_transcoder;
std::unordered_map<uintptr_t, void*> g_aligned_slots;

uint8_t* g_input_buffer = nullptr;
uint32_t g_input_capacity = 0;

uint32_t g_header_info[8] = {0};

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
void ktx2_init() {
  if (!g_initialized) {
    basist::basisu_transcoder_init();
    g_initialized = true;
  }
}

// Allocates a `size`-byte region in Wasm linear memory whose start address is
// aligned to 64 KiB, with a full 64 KiB guard margin on both ends so malloc
// metadata never shares a page with an mmapped GPUBuffer range.
EMSCRIPTEN_KEEPALIVE
uintptr_t ktx2_alloc_slot(uint32_t size, int touch_pages) {
  const size_t total = static_cast<size_t>(size) + 2 * kSlotAlignment;
  void* raw = std::malloc(total);
  if (!raw) {
    return 0;
  }
  const uintptr_t raw_addr = reinterpret_cast<uintptr_t>(raw);
  const uintptr_t aligned =
      (raw_addr + kSlotAlignment) & ~(kSlotAlignment - 1);

  if (touch_pages && size > 0) {
    // Fault in anonymous heap pages upfront outside timed steady-state loops.
    // (Skipped for mmap target slots since MAP_FIXED replaces those pages.)
    uint8_t* p = reinterpret_cast<uint8_t*>(aligned);
    for (size_t offset = 0; offset < size; offset += 4096) {
      p[offset] = 0;
    }
    p[size - 1] = 0;
  }

  g_aligned_slots[aligned] = raw;
  return aligned;
}

EMSCRIPTEN_KEEPALIVE
void ktx2_free_slot(uintptr_t aligned_ptr) {
  auto it = g_aligned_slots.find(aligned_ptr);
  if (it != g_aligned_slots.end()) {
    std::free(it->second);
    g_aligned_slots.erase(it);
  }
}

// Ensures a reusable buffer in Wasm memory for holding compressed .ktx2 bytes.
EMSCRIPTEN_KEEPALIVE
uintptr_t ktx2_ensure_input_buffer(uint32_t size) {
  if (size > g_input_capacity) {
    uint8_t* next = static_cast<uint8_t*>(std::realloc(g_input_buffer, size));
    if (!next) {
      return 0;
    }
    g_input_buffer = next;
    g_input_capacity = size;
  }
  return reinterpret_cast<uintptr_t>(g_input_buffer);
}

EMSCRIPTEN_KEEPALIVE
uintptr_t ktx2_get_header_info_ptr() {
  return reinterpret_cast<uintptr_t>(g_header_info);
}

// Parses KTX2 header metadata into `g_header_info`:
//   [0] width
//   [1] height
//   [2] levels
//   [3] faces
//   [4] is_uastc (1 = UASTC, 0 = ETC1S/other)
//   [5] has_alpha
//   [6] is_srgb
//   [7] supercompression_scheme
EMSCRIPTEN_KEEPALIVE
int ktx2_inspect_header(uintptr_t ktx2_ptr, uint32_t ktx2_size) {
  ktx2_init();
  basist::ktx2_transcoder tmp;
  if (!tmp.init(reinterpret_cast<const void*>(ktx2_ptr), ktx2_size)) {
    return 0;
  }
  g_header_info[0] = tmp.get_width();
  g_header_info[1] = tmp.get_height();
  g_header_info[2] = tmp.get_levels();
  g_header_info[3] = tmp.get_faces();
  g_header_info[4] = tmp.is_uastc() ? 1u : 0u;
  g_header_info[5] = tmp.get_has_alpha() ? 1u : 0u;
  g_header_info[6] = tmp.is_srgb() ? 1u : 0u;
  g_header_info[7] = tmp.get_header().m_supercompression_scheme;
  return 1;
}

EMSCRIPTEN_KEEPALIVE
uint32_t ktx2_compute_transcoded_byte_size(uint32_t target_format,
                                           uint32_t width,
                                           uint32_t height) {
  ktx2_init();
  const auto fmt =
      static_cast<basist::transcoder_texture_format>(target_format);
  return basist::basis_compute_transcoded_image_size_in_bytes(fmt, width,
                                                              height);
}

// Transcodes mip level 0 (layer 0, face 0) directly into `dst_ptr`.
// Returns 0 on success, negative error code on failure.
EMSCRIPTEN_KEEPALIVE
int ktx2_transcode_level0(uintptr_t ktx2_ptr,
                          uint32_t ktx2_size,
                          uintptr_t dst_ptr,
                          uint32_t dst_byte_size,
                          uint32_t target_format) {
  ktx2_init();

  const void* src = reinterpret_cast<const void*>(ktx2_ptr);
  if (!g_transcoder.init(src, ktx2_size)) {
    return -1;
  }
  if (!g_transcoder.start_transcoding()) {
    return -2;
  }

  const auto fmt =
      static_cast<basist::transcoder_texture_format>(target_format);
  const uint32_t bytes_per_block_or_pixel =
      basist::basis_get_bytes_per_block_or_pixel(fmt);
  if (bytes_per_block_or_pixel == 0) {
    return -3;
  }

  const uint32_t output_blocks_or_pixels =
      dst_byte_size / bytes_per_block_or_pixel;

  const bool ok = g_transcoder.transcode_image_level(
      /*level_index=*/0,
      /*layer_index=*/0,
      /*face_index=*/0,
      /*pOutput_blocks=*/reinterpret_cast<void*>(dst_ptr),
      /*output_blocks_buf_size_in_blocks_or_pixels=*/output_blocks_or_pixels,
      fmt);

  return ok ? 0 : -4;
}

}  // extern "C"
