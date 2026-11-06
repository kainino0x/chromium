// Bounded per-size MAP_WRITE GPUBuffer pool for pipelined texture uploads.
//
// Key design details for the mmap prototype:
// 1. Buffers are bucketed by `alignedBufferBytes` (multiples of 2 MiB) and
//    retained per size rather than destroyed on size switches, preventing
//    Chromium's MappedMemoryManager from sub-allocating a smaller buffer inside
//    a previously freed larger shared-memory chunk.
// 2. Each pooled GPUBuffer owns a dedicated 64 KiB-aligned Wasm memory slot
//    (`buffer.wasmSlotPtr`) so persistent-mapping modes that key by Wasm target
//    address always associate a slot with the same underlying GPUBuffer fd.
// 3. Caps total live buffers per size (`maxBuffersPerSize`) and awaits the next
//    completed `mapAsync(GPUMapMode.WRITE)` when all buffers are in flight.

import { device } from './ktx2_device.js';

const poolsBySize = new Map();

function getBucket(byteSize) {
  let bucket = poolsBySize.get(byteSize);
  if (!bucket) {
    bucket = {
      available: [],
      totalCreated: 0,
      waiters: [],
    };
    poolsBySize.set(byteSize, bucket);
  }
  return bucket;
}

export const Ktx2UploadPool = {
  async acquire(alignedByteSize, maxBuffersPerSize) {
    const bucket = getBucket(alignedByteSize);

    if (bucket.available.length > 0) {
      return bucket.available.pop();
    }

    if (bucket.totalCreated < maxBuffersPerSize) {
      const index = bucket.totalCreated++;
      const buffer = device.createBuffer({
        label: `ktx2 upload buffer #${index} (${(alignedByteSize / (1024 * 1024)).toFixed(1)} MiB)`,
        size: alignedByteSize,
        usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.MAP_WRITE,
        mappedAtCreation: true,
      });
      buffer.wasmSlotPtr = 0;
      return buffer;
    }

    return new Promise((resolve) => {
      bucket.waiters.push(resolve);
    });
  },

  release(buffer) {
    const bucket = getBucket(buffer.size);
    buffer.mapAsync(GPUMapMode.WRITE).then(() => {
      if (bucket.waiters.length > 0) {
        const resolve = bucket.waiters.shift();
        resolve(buffer);
      } else {
        bucket.available.push(buffer);
      }
    });
  },

  statsForSize(alignedByteSize) {
    const bucket = poolsBySize.get(alignedByteSize);
    if (!bucket) {
      return { available: 0, totalCreated: 0 };
    }
    return {
      available: bucket.available.length,
      totalCreated: bucket.totalCreated,
    };
  },
};
