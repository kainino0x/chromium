// Main continuous streaming loop for the KTX2 Wasm -> WebGPU upload benchmark.
//
// Pipeline:
// 1. StreamingFetchPipeline keeps N cache-busted HTTP fetches in flight so
//    compressed .ktx2 payloads arrive continuously.
// 2. As soon as a payload is ready (and a MAP_WRITE GPUBuffer is acquired from
//    Ktx2UploadPool when using `copy` or `mmap`), Wasm decodes the KTX2 payload:
//    - In `mmap` mode: GPUBuffer.getMMapDescriptor(0, size).map(wasmMemory, ptr)
//      maps the GPU staging buffer directly into Wasm linear memory, and BasisU
//      transcodes directly into `ptr`. Then `uploadBuffer.unmap()` +
//      `copyBufferToTexture` uploads to the GPUTexture with zero CPU memcpy.
//    - In `copy` mode: BasisU transcodes into Wasm heap, JS copies from Wasm
//      heap into `uploadBuffer.getMappedRange()`, unmaps, and calls
//      `copyBufferToTexture`.
//    - In `writeTexture` mode: BasisU transcodes into Wasm heap, JS calls
//      `device.queue.writeTexture`.
//    - In `writeBuffer` mode: BasisU transcodes into Wasm heap, JS calls
//      `device.queue.writeBuffer` + `copyBufferToTexture`.

import {
  device,
  hasCrashed,
  hasMMapSupport,
  computeTextureLayout,
  setOnFailCallback,
  fail,
} from './ktx2_device.js';
import { Ktx2Wasm } from './ktx2_wasm.js';
import { StreamingFetchPipeline } from './ktx2_fetcher.js';
import { Ktx2UploadPool } from './ktx2_upload_pool.js';
import { Ktx2GPU } from './ktx2_gpu.js';
import {
  ASSETS,
  config,
  pauseConfig,
  runtimeState,
  stats,
  resetStats,
  resetIfNeeded,
  renderReadout,
  setOnPauseToggle,
  forcePauseFromError,
} from './ktx2_ui.js';

setOnFailCallback(() => {
  forcePauseFromError();
});

const fetcher = new StreamingFetchPipeline();

setOnPauseToggle((paused) => {
  fetcher.setPaused(paused);
  if (!paused) {
    // Reset iteration delta clock so pause duration isn't counted in iterWall.
    tLastIter = null;
  }
  renderReadout(true);
});

let currentLayout = null;
let seededHeapDecodeForSkipMode = false;
let tLastIter = null;
let frameNum = 0;

function applyConfigReset() {
  const asset = ASSETS[config.assetKey];
  currentLayout = computeTextureLayout(
    asset.width,
    asset.height,
    config.targetFormat
  );
  Ktx2GPU.ensureResources(currentLayout);

  runtimeState.width = asset.width;
  runtimeState.height = asset.height;
  runtimeState.decodedBytes = currentLayout.decodedBytes;
  runtimeState.compressedBytes = 0;

  fetcher.configure({
    assetUrl: asset.url,
    pipelineDepth: config.fetchPipelineDepth,
  });

  seededHeapDecodeForSkipMode = false;
  tLastIter = null;
  resetStats();
}

async function streamOneTexture() {
  resetIfNeeded(applyConfigReset);

  if (config.uploadMethod === 'mmap' && !hasMMapSupport) {
    fail(
      'Selected upload mode "mmap", but GPUBuffer.prototype.getMMapDescriptor ' +
      'is not available in this browser.\n\n' +
      'Launch the prototype Chromium build with:\n' +
      '  --js-flags=--experimental-wasm-memory-control\n' +
      'or switch upload mode to "copy", "writeTexture", or "writeBuffer".'
    );
  }

  const layout = currentLayout;

  // 1. Await next streamed KTX2 payload from the concurrent fetch pipeline.
  const t0 = performance.now();
  const payload = await fetcher.nextPayload();
  const t1 = performance.now();

  runtimeState.compressedBytes = payload.bytes.byteLength;
  runtimeState.inFlightFetches = fetcher.inFlightCount;
  runtimeState.readyPayloads = fetcher.readyCount;

  // 2. Acquire a mapped MAP_WRITE GPUBuffer if using `copy` or `mmap`, and
  // ensure any one-time Wasm destination slot allocation happens before t3.
  let uploadBuffer = null;
  if (config.uploadMethod === 'copy' || config.uploadMethod === 'mmap') {
    uploadBuffer = await Ktx2UploadPool.acquire(
      layout.alignedBufferBytes,
      config.uploadPoolSize
    );
  }
  let heapSlotPtr = 0;
  if (config.uploadMethod === 'mmap') {
    if (!uploadBuffer.wasmSlotPtr) {
      uploadBuffer.wasmSlotPtr = Ktx2Wasm.allocMMapSlot(
        layout.alignedBufferBytes
      );
    }
  } else {
    heapSlotPtr = Ktx2Wasm.getHeapDecodeSlot(layout.alignedBufferBytes);
  }
  const t2 = performance.now();

  const poolStats = Ktx2UploadPool.statsForSize(layout.alignedBufferBytes);
  runtimeState.poolAvailable = poolStats.available;
  runtimeState.poolTotal = poolStats.totalCreated;

  // 3. Stage the compressed KTX2 file bytes into the reusable Wasm input buffer.
  // When `doWasmDecode` is unchecked (synthetic upload-only diagnostic mode),
  // seed each destination buffer once outside the timed window so the preview
  // still shows a valid image without timing Wasm decompression.
  let inputPtr = 0;
  let inputLength = payload.bytes.byteLength;
  const needsOneTimeSeed =
    !config.doWasmDecode &&
    (config.uploadMethod === 'mmap'
      ? !uploadBuffer.seeded
      : !seededHeapDecodeForSkipMode);

  if (config.doWasmDecode || needsOneTimeSeed) {
    ({ inputPtr, inputLength } = Ktx2Wasm.stageCompressedInput(payload.bytes));
  }
  if (needsOneTimeSeed) {
    let seedPtr = heapSlotPtr;
    if (config.uploadMethod === 'mmap') {
      const seedDesc = uploadBuffer.getMMapDescriptor(
        0,
        layout.alignedBufferBytes
      );
      seedDesc.map(Ktx2Wasm.memory, uploadBuffer.wasmSlotPtr);
      seedPtr = uploadBuffer.wasmSlotPtr;
    }
    Ktx2Wasm.transcodeToPtr(
      inputPtr,
      inputLength,
      seedPtr,
      layout.decodedBytes,
      layout.basisFormat
    );
    if (config.uploadMethod === 'mmap') {
      uploadBuffer.unmap();
      await uploadBuffer.mapAsync(GPUMapMode.WRITE);
      uploadBuffer.seeded = true;
    } else {
      seededHeapDecodeForSkipMode = true;
    }
  }
  const t3 = performance.now();

  // 4. CPU critical path: [mmap setup] -> [Wasm KTX2 decode] -> [upload / unmap].
  let dstPtr = 0;
  if (config.uploadMethod === 'mmap') {
    // Map the WebGPU staging buffer directly into Wasm linear memory.
    const mmapDescriptor = uploadBuffer.getMMapDescriptor(
      0,
      layout.alignedBufferBytes
    );
    mmapDescriptor.map(Ktx2Wasm.memory, uploadBuffer.wasmSlotPtr);
    dstPtr = uploadBuffer.wasmSlotPtr;
  } else {
    dstPtr = heapSlotPtr;
  }
  const t4 = performance.now();

  if (config.doWasmDecode) {
    Ktx2Wasm.transcodeToPtr(
      inputPtr,
      inputLength,
      dstPtr,
      layout.decodedBytes,
      layout.basisFormat
    );
  }
  const t5 = performance.now();

  const commandEncoder = device.createCommandEncoder();
  switch (config.uploadMethod) {
    case 'mmap': {
      // Data was decoded directly into the mmapped GPUBuffer. Only GPUBuffer.unmap()
      // is needed (munmap on the descriptor is never necessary), followed by GPU
      // copyBufferToTexture.
      uploadBuffer.unmap();
      commandEncoder.copyBufferToTexture(
        {
          buffer: uploadBuffer,
          offset: 0,
          bytesPerRow: layout.bytesPerRow,
          rowsPerImage: layout.rowsPerImage,
        },
        { texture: Ktx2GPU.texture },
        [layout.width, layout.height, 1]
      );
      break;
    }
    case 'copy': {
      // Released WebGPU API path: wrap mapped GPU buffer in an ArrayBuffer via
      // getMappedRange() and copy decoded bytes out of Wasm memory.
      const wasmHeapView = new Uint8Array(
        Ktx2Wasm.memory.buffer,
        dstPtr,
        layout.decodedBytes
      );
      new Uint8Array(uploadBuffer.getMappedRange(0, layout.decodedBytes)).set(
        wasmHeapView
      );
      uploadBuffer.unmap();
      commandEncoder.copyBufferToTexture(
        {
          buffer: uploadBuffer,
          offset: 0,
          bytesPerRow: layout.bytesPerRow,
          rowsPerImage: layout.rowsPerImage,
        },
        { texture: Ktx2GPU.texture },
        [layout.width, layout.height, 1]
      );
      break;
    }
    case 'writeTexture': {
      const wasmHeapView = new Uint8Array(
        Ktx2Wasm.memory.buffer,
        dstPtr,
        layout.decodedBytes
      );
      device.queue.writeTexture(
        { texture: Ktx2GPU.texture },
        wasmHeapView,
        {
          offset: 0,
          bytesPerRow: layout.bytesPerRow,
          rowsPerImage: layout.rowsPerImage,
        },
        [layout.width, layout.height, 1]
      );
      break;
    }
    case 'writeBuffer': {
      const wasmHeapView = new Uint8Array(
        Ktx2Wasm.memory.buffer,
        dstPtr,
        layout.decodedBytes
      );
      device.queue.writeBuffer(
        Ktx2GPU.stagingBuffer,
        0,
        wasmHeapView,
        0,
        layout.decodedBytes
      );
      commandEncoder.copyBufferToTexture(
        {
          buffer: Ktx2GPU.stagingBuffer,
          offset: 0,
          bytesPerRow: layout.bytesPerRow,
          rowsPerImage: layout.rowsPerImage,
        },
        { texture: Ktx2GPU.texture },
        [layout.width, layout.height, 1]
      );
      break;
    }
    default:
      throw new Error(`Unknown upload method: ${config.uploadMethod}`);
  }
  const t6 = performance.now();

  if (config.renderPreview) {
    Ktx2GPU.encodePreviewPass(commandEncoder, layout, frameNum);
  }
  device.queue.submit([commandEncoder.finish()]);

  if (uploadBuffer) {
    Ktx2UploadPool.release(uploadBuffer);
  }

  // For modes that don't gate on MAP_WRITE buffer recycling (`writeTexture` and
  // `writeBuffer`), bound maximum queued GPU submissions using onSubmittedWorkDone
  // every `uploadPoolSize` frames so we don't starve the browser compositor or
  // buffer an unbounded queue of multi-64MB staging writes.
  if (!uploadBuffer && (frameNum + 1) % config.uploadPoolSize === 0) {
    await device.queue.onSubmittedWorkDone();
  }

  const now = performance.now();
  stats.fetchWait.addSample(t1 - t0);
  stats.acquireWait.addSample(t2 - t1);
  stats.stageInputCpu.addSample(t3 - t2);
  stats.mmapSetupCpu.addSample(t4 - t3);
  stats.wasmDecodeCpu.addSample(t5 - t4);
  stats.uploadOrUnmapCpu.addSample(t6 - t5);
  stats.cpuTotal.addSample(t6 - t3);

  if (tLastIter !== null) {
    stats.iterWall.addSample(now - tLastIter);
  }
  tLastIter = now;
  frameNum++;

  renderReadout(false);
}

// Main async loop
while (!hasCrashed()) {
  if (pauseConfig.pause || document.hidden) {
    tLastIter = null;
    await new Promise(requestAnimationFrame);
  } else {
    await streamOneTexture();
  }
}
