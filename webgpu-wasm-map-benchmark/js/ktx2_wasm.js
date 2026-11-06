// Instantiates the thin C++ Basis Universal + Zstd Wasm module and manages
// 64 KiB-aligned linear-memory slots for both Wasm-heap decoding and WebGPU
// GPUBuffer mmap targets.

import createKtx2Decoder from '../build/ktx2_decoder.js';

const wasmInstance = await createKtx2Decoder();
wasmInstance._ktx2_init();

const heapSlotsBySize = new Map();

export const Ktx2Wasm = {
  get memory() {
    return wasmInstance.wasmMemory;
  },

  // Returns a reusable 64 KiB-aligned Wasm heap slot for non-mmap modes
  // (`copy`, `writeTexture`, `writeBuffer`). Kept separate from mmap slots so
  // persistent mprotect(PROT_NONE) on unmapped GPUBuffer slots never touches it.
  getHeapDecodeSlot(alignedByteSize) {
    let ptr = heapSlotsBySize.get(alignedByteSize);
    if (!ptr) {
      ptr = wasmInstance._ktx2_alloc_slot(alignedByteSize, 1) >>> 0;
      if (!ptr) {
        throw new Error(`Failed to allocate ${alignedByteSize} bytes in Wasm heap`);
      }
      heapSlotsBySize.set(alignedByteSize, ptr);
    }
    return ptr;
  },

  // Allocates a dedicated 64 KiB-aligned Wasm address range for a pooled
  // GPUBuffer so each GPUBuffer consistently maps onto its own Wasm slot.
  allocMMapSlot(alignedByteSize) {
    const ptr = wasmInstance._ktx2_alloc_slot(alignedByteSize, 0) >>> 0;
    if (!ptr) {
      throw new Error(`Failed to allocate Wasm mmap slot of ${alignedByteSize} bytes`);
    }
    return ptr;
  },

  freeSlot(ptr) {
    if (ptr) {
      wasmInstance._ktx2_free_slot(ptr >>> 0);
    }
  },

  // Copies compressed .ktx2 file bytes into a reusable Wasm input buffer and
  // returns `{ inputPtr, inputLength }`.
  stageCompressedInput(compressedUint8) {
    const len = compressedUint8.byteLength;
    const inputPtr = wasmInstance._ktx2_ensure_input_buffer(len) >>> 0;
    if (!inputPtr) {
      throw new Error(`Failed to allocate Wasm input buffer of ${len} bytes`);
    }
    new Uint8Array(wasmInstance.wasmMemory.buffer, inputPtr, len).set(compressedUint8);
    return { inputPtr, inputLength: len };
  },

  inspectHeader(inputPtr, inputLength) {
    const ok = wasmInstance._ktx2_inspect_header(inputPtr >>> 0, inputLength >>> 0);
    if (!ok) {
      throw new Error('Failed to parse KTX2 header in Wasm transcoder');
    }
    const infoPtr = wasmInstance._ktx2_get_header_info_ptr() >>> 0;
    const info = new Uint32Array(wasmInstance.wasmMemory.buffer, infoPtr, 8);
    return {
      width: info[0],
      height: info[1],
      levels: info[2],
      faces: info[3],
      isUastc: info[4] === 1,
      hasAlpha: info[5] === 1,
      isSrgb: info[6] === 1,
      supercompression: info[7],
    };
  },

  transcodeToPtr(inputPtr, inputLength, dstPtr, dstByteSize, basisFormat) {
    const rc = wasmInstance._ktx2_transcode_level0(
      inputPtr >>> 0,
      inputLength >>> 0,
      dstPtr >>> 0,
      dstByteSize >>> 0,
      basisFormat >>> 0
    );
    if (rc !== 0) {
      throw new Error(`Wasm KTX2 transcode failed with code ${rc}`);
    }
  },
};
