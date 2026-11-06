// WebGPU adapter/device initialization, compressed format feature detection,
// layout helpers, and uncaught error reporting for the KTX2 benchmark.

let crashed = false;
let onFailCallback = null;

export function hasCrashed() {
  return crashed;
}

export function setOnFailCallback(fn) {
  onFailCallback = fn;
}

export const fail = (() => {
  let output;
  function createErrorOutput() {
    if (typeof document === 'undefined') {
      return { show(msg) { console.error(msg); } };
    }
    const dialogBox = document.createElement('dialog');
    dialogBox.close();
    document.body.append(dialogBox);

    const dialogText = document.createElement('pre');
    dialogText.style.whiteSpace = 'pre-wrap';
    dialogBox.append(dialogText);

    return {
      show(msg) {
        if (!dialogBox.open) {
          dialogText.textContent = msg;
          dialogBox.showModal();
        }
      },
    };
  }

  return (message) => {
    crashed = true;
    if (onFailCallback) {
      onFailCallback();
    }
    if (!output) {
      output = createErrorOutput();
    }
    output.show(String(message));
    throw new Error(message);
  };
})();

globalThis.addEventListener('unhandledrejection', (ev) => {
  fail(`Unhandled promise rejection:\n${ev.reason?.stack || ev.reason}`);
});
globalThis.addEventListener('error', (ev) => {
  fail(`Uncaught exception:\n${ev.error?.stack || ev.message}`);
});

if (!navigator.gpu) {
  fail('WebGPU (navigator.gpu) is not available in this browser.');
}

const adapter = await navigator.gpu.requestAdapter();
if (!adapter) {
  fail('Failed to obtain a WebGPU adapter.');
}

const optionalCompressionFeatures = [
  'texture-compression-bc',
  'texture-compression-astc',
  'texture-compression-etc2',
];
const requiredFeatures = optionalCompressionFeatures.filter((f) =>
  adapter.features.has(f)
);

// Request up to 8192+ 2D texture dimension and up to 512 MiB buffer size
// (256 MiB already fits 8192x8192 rgba8unorm; 512 MiB gives extra headroom).
const desiredMaxTex2D = Math.min(adapter.limits.maxTextureDimension2D, 16384);
const desiredMaxBuffer = Math.min(
  adapter.limits.maxBufferSize,
  512 * 1024 * 1024
);

export const device = await adapter.requestDevice({
  requiredFeatures,
  requiredLimits: {
    maxTextureDimension2D: desiredMaxTex2D,
    maxBufferSize: desiredMaxBuffer,
  },
});

device.lost.then((lostInfo) => {
  fail(`WebGPU device lost (${lostInfo.reason}): ${lostInfo.message}`);
});
device.onuncapturederror = (ev) => {
  fail(`WebGPU validation/runtime error:\n${ev.error.message}`);
};

export const canvas = document.getElementById('cvs');
export const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
export const ctx = canvas.getContext('webgpu');
ctx.configure({
  device,
  format: canvasFormat,
  alphaMode: 'opaque',
});

export const hasMMapSupport =
  typeof GPUBuffer !== 'undefined' &&
  'getMMapDescriptor' in GPUBuffer.prototype;

// Basis Universal `transcoder_texture_format` enum values (from basisu_transcoder.h)
export const BasisFormat = {
  ETC2_RGBA: 1,
  BC1_RGB: 2,
  BC7_RGBA: 6,
  ASTC_4x4_RGBA: 10,
  RGBA32: 13,
};

export const FORMAT_SPECS = {
  'bc7-rgba-unorm': {
    label: 'bc7-rgba-unorm (16 B / 4x4 block)',
    basisFormat: BasisFormat.BC7_RGBA,
    isCompressed: true,
    blockWidth: 4,
    blockHeight: 4,
    bytesPerBlockOrPixel: 16,
    requiredFeature: 'texture-compression-bc',
  },
  'bc1-rgba-unorm': {
    label: 'bc1-rgba-unorm (8 B / 4x4 block)',
    basisFormat: BasisFormat.BC1_RGB,
    isCompressed: true,
    blockWidth: 4,
    blockHeight: 4,
    bytesPerBlockOrPixel: 8,
    requiredFeature: 'texture-compression-bc',
  },
  'astc-4x4-unorm': {
    label: 'astc-4x4-unorm (16 B / 4x4 block)',
    basisFormat: BasisFormat.ASTC_4x4_RGBA,
    isCompressed: true,
    blockWidth: 4,
    blockHeight: 4,
    bytesPerBlockOrPixel: 16,
    requiredFeature: 'texture-compression-astc',
  },
  'etc2-rgba8unorm': {
    label: 'etc2-rgba8unorm (16 B / 4x4 block)',
    basisFormat: BasisFormat.ETC2_RGBA,
    isCompressed: true,
    blockWidth: 4,
    blockHeight: 4,
    bytesPerBlockOrPixel: 16,
    requiredFeature: 'texture-compression-etc2',
  },
  'rgba8unorm': {
    label: 'rgba8unorm (uncompressed, 4 B / px)',
    basisFormat: BasisFormat.RGBA32,
    isCompressed: false,
    blockWidth: 1,
    blockHeight: 1,
    bytesPerBlockOrPixel: 4,
    requiredFeature: null,
  },
};

export const supportedTargetFormats = Object.entries(FORMAT_SPECS)
  .filter(([, spec]) => !spec.requiredFeature || device.features.has(spec.requiredFeature))
  .map(([fmt]) => fmt);

// Chromium's MappedMemoryManager allocates transfer buffer shared memory chunks
// in multiples of `mapped_memory_chunk_size` (2 MiB), and the mmap prototype
// currently asserts `offset == 0 && pointer.size() == chunk->GetSize()`.
export const kShmChunkMultiple = 2 * 1024 * 1024;

export function roundUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

export function computeTextureLayout(width, height, webgpuFormat) {
  const spec = FORMAT_SPECS[webgpuFormat];
  if (!spec) {
    throw new Error(`Unsupported target texture format: ${webgpuFormat}`);
  }
  const unitsX = Math.ceil(width / spec.blockWidth);
  const unitsY = Math.ceil(height / spec.blockHeight);
  const unalignedBytesPerRow = unitsX * spec.bytesPerBlockOrPixel;
  // WebGPU requires bytesPerRow to be a multiple of 256 for copyBufferToTexture.
  // For 4096 and 8192 widths across all formats above, unalignedBytesPerRow is
  // already a multiple of 8192 (and therefore 256).
  const bytesPerRow = roundUp(unalignedBytesPerRow, 256);
  const rowsPerImage = unitsY;
  const decodedBytes = bytesPerRow * rowsPerImage;
  const alignedBufferBytes = roundUp(decodedBytes, kShmChunkMultiple);

  return {
    width,
    height,
    webgpuFormat,
    basisFormat: spec.basisFormat,
    isCompressed: spec.isCompressed,
    bytesPerRow,
    rowsPerImage,
    decodedBytes,
    alignedBufferBytes,
  };
}
