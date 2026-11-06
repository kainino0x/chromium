// Tweakpane controls, rolling statistical accumulators, GB/s + variance
// formatting, baseline pinning, and copyable on-screen performance readout.

import { Pane } from '../third_party/tweakpane.min.js';
import {
  device,
  hasMMapSupport,
  supportedTargetFormats,
  FORMAT_SPECS,
} from './ktx2_device.js';

export const ASSETS = {
  'env_4096_etc1s': {
    label: '4096x4096 ETC1S (1.2 MB -> glTF-Sample-Environments)',
    url: 'assets/env_4096_etc1s.ktx2',
    width: 4096,
    height: 4096,
    codec: 'ETC1S',
  },
  'env_4096_uastc': {
    label: '4096x4096 UASTC+Zstd (7.2 MB -> glTF-Sample-Environments)',
    url: 'assets/env_4096_uastc.ktx2',
    width: 4096,
    height: 4096,
    codec: 'UASTC+Zstd',
  },
  'env_8192_etc1s': {
    label: '8192x8192 ETC1S (3.8 MB -> glTF-Sample-Environments)',
    url: 'assets/env_8192_etc1s.ktx2',
    width: 8192,
    height: 8192,
    codec: 'ETC1S',
  },
  'env_8192_uastc': {
    label: '8192x8192 UASTC+Zstd (24.4 MB -> glTF-Sample-Environments)',
    url: 'assets/env_8192_uastc.ktx2',
    width: 8192,
    height: 8192,
    codec: 'UASTC+Zstd',
  },
};

export const UPLOAD_MODE_LABELS = {
  copy: 'copy (getMappedRange ArrayBuffer -> set -> unmap -> copyBufferToTexture)',
  mmap: 'mmap (getMMapDescriptor -> direct Wasm decode -> unmap -> copyBufferToTexture)',
  writeTexture: 'writeTexture (Wasm heap -> queue.writeTexture)',
  writeBuffer: 'writeBuffer (Wasm heap -> queue.writeBuffer -> copyBufferToTexture)',
};

const pane = new Pane({ container: document.getElementById('panediv') });

export const pauseConfig = {
  pause: false,
};

let onPauseToggle = null;
export function setOnPauseToggle(fn) {
  onPauseToggle = fn;
}

const pauseBinding = pane.addBinding(pauseConfig, 'pause', { label: 'pause' });
pauseBinding.on('change', () => {
  if (onPauseToggle) {
    onPauseToggle(pauseConfig.pause);
  }
  updateStatusBadge();
});

const info = {
  highPrecisionTimestamps: window.crossOriginIsolated,
  mmapPrototypeAPI: hasMMapSupport,
  vendor: device.adapterInfo?.vendor || 'unknown',
  architecture: device.adapterInfo?.architecture || 'unknown',
  maxTexDim2D: device.limits.maxTextureDimension2D,
};
const fInfo = pane.addFolder({ title: 'Environment Info' });
fInfo.addBinding(info, 'highPrecisionTimestamps', { readonly: true });
fInfo.addBinding(info, 'mmapPrototypeAPI', { readonly: true });
fInfo.addBinding(info, 'vendor', { readonly: true });
fInfo.addBinding(info, 'architecture', { readonly: true });
fInfo.addBinding(info, 'maxTexDim2D', { readonly: true, format: (v) => v.toFixed(0) });

// Filter assets that fit within device.limits.maxTextureDimension2D
const availableAssetEntries = Object.entries(ASSETS).filter(
  ([, a]) =>
    a.width <= device.limits.maxTextureDimension2D &&
    a.height <= device.limits.maxTextureDimension2D
);
const assetOptions = Object.fromEntries(
  availableAssetEntries.map(([key, a]) => [a.label, key])
);

const formatOptions = Object.fromEntries(
  supportedTargetFormats.map((fmt) => [FORMAT_SPECS[fmt].label, fmt])
);

const defaultFormat = supportedTargetFormats.includes('rgba8unorm')
  ? 'rgba8unorm'
  : supportedTargetFormats[0];

const urlParams = new URLSearchParams(window.location.search);
const paramAsset = urlParams.get('asset');
const paramFormat = urlParams.get('format');
const paramMode = urlParams.get('mode');
const paramDecode = urlParams.get('decode');
const paramPreview = urlParams.get('preview');

const liveConfig = {
  assetKey: paramAsset && ASSETS[paramAsset] ? paramAsset : 'env_4096_etc1s',
  targetFormat:
    paramFormat && supportedTargetFormats.includes(paramFormat)
      ? paramFormat
      : defaultFormat,
  uploadMethod:
    paramMode && paramMode in UPLOAD_MODE_LABELS ? paramMode : 'copy',
  fetchPipelineDepth: 4,
  uploadPoolSize: 4,
  doWasmDecode: paramDecode !== null ? paramDecode !== 'false' : true,
  renderPreview: paramPreview !== null ? paramPreview !== 'false' : true,
  maxSamples: 500,
};

export const config = { ...liveConfig };
let needReset = true;

function commitConfig() {
  Object.assign(config, liveConfig);
}
commitConfig();

const fConfig = pane.addFolder({ title: 'Configuration' });
fConfig.on('change', () => {
  needReset = true;
});

fConfig.addBinding(liveConfig, 'assetKey', {
  label: 'KTX2 asset',
  options: assetOptions,
});
fConfig.addBinding(liveConfig, 'targetFormat', {
  label: 'GPU format',
  options: formatOptions,
});
fConfig.addBinding(liveConfig, 'uploadMethod', {
  label: 'upload mode',
  options: {
    'copy: getMappedRange + copy + copyBufferToTexture': 'copy',
    'mmap: getMMapDescriptor + direct decode + copyBufferToTexture': 'mmap',
    'writeTexture: queue.writeTexture from Wasm heap': 'writeTexture',
    'writeBuffer: queue.writeBuffer + copyBufferToTexture': 'writeBuffer',
  },
});
fConfig.addBinding(liveConfig, 'fetchPipelineDepth', {
  label: 'fetch pipeline',
  min: 1,
  max: 12,
  step: 1,
});
fConfig.addBinding(liveConfig, 'uploadPoolSize', {
  label: 'upload pool',
  min: 2,
  max: 8,
  step: 1,
});
fConfig.addBinding(liveConfig, 'doWasmDecode', { label: 'doWasmDecode' });
fConfig.addBinding(liveConfig, 'renderPreview', { label: 'renderPreview' });
fConfig.addBinding(liveConfig, 'maxSamples', {
  label: 'sample window',
  min: 20,
  max: 2000,
  step: 10,
});

// Rolling sample accumulator computing sample mean and standard error of the
// mean (SEM = stddev / sqrt(N), matching SmoothedTiming in js/ui.js).
class RollingStats {
  values = [];
  nextWriteIndex = 0;

  reset() {
    this.values.length = 0;
    this.nextWriteIndex = 0;
  }

  get count() {
    return this.values.length;
  }

  addSample(value) {
    const cap = Math.max(2, liveConfig.maxSamples | 0);
    if (this.values.length > cap) {
      this.values.length = cap;
      this.nextWriteIndex = this.nextWriteIndex % cap;
    }
    if (this.values.length < cap) {
      this.values.push(value);
      this.nextWriteIndex = this.values.length;
    } else {
      this.values[this.nextWriteIndex % cap] = value;
      this.nextWriteIndex++;
    }
  }

  getMeanAndSem() {
    const n = this.values.length;
    if (n === 0) {
      return { mean: NaN, sem: NaN, stdDev: NaN, n: 0 };
    }
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += this.values[i];
    }
    const mean = sum / n;
    if (n < 2) {
      return { mean, sem: 0, stdDev: 0, n };
    }
    let sqSum = 0;
    for (let i = 0; i < n; i++) {
      const d = this.values[i] - mean;
      sqSum += d * d;
    }
    const stdDev = Math.sqrt(sqSum / (n - 1));
    const sem = stdDev / Math.sqrt(n);
    return { mean, sem, stdDev, n };
  }

  formatMs() {
    const { mean, sem, n } = this.getMeanAndSem();
    if (n === 0) return '-';
    return `${mean.toFixed(3)} \u00b1 ${sem.toFixed(3)} ms`;
  }

  // Converts time mean +- SEM (in ms) into effective throughput in GB/s +- SEM
  // via error propagation: B = GB / t_sec, sigma_B = B * (sem_ms / mean_ms).
  getBandwidthStats(numBytes) {
    const { mean, sem, n } = this.getMeanAndSem();
    if (n === 0 || !(mean > 0) || !(numBytes > 0)) {
      return { bwMean: NaN, bwSem: NaN, n };
    }
    const gb = numBytes / 1e9;
    const bwMean = gb / (mean / 1e3);
    const bwSem = bwMean * (sem / mean);
    return { bwMean, bwSem, n };
  }

  formatGBps(numBytes) {
    const { bwMean, bwSem, n } = this.getBandwidthStats(numBytes);
    if (n === 0 || !Number.isFinite(bwMean)) {
      return '-';
    }
    return `${bwMean.toFixed(3)} \u00b1 ${bwSem.toFixed(3)} GB/s`;
  }
}

export const runtimeState = {
  decodedBytes: 0,
  compressedBytes: 0,
  width: 4096,
  height: 4096,
  inFlightFetches: 0,
  readyPayloads: 0,
  poolAvailable: 0,
  poolTotal: 0,
};

export const stats = {
  fetchWait: new RollingStats(),
  acquireWait: new RollingStats(),
  stageInputCpu: new RollingStats(),
  mmapSetupCpu: new RollingStats(),
  wasmDecodeCpu: new RollingStats(),
  uploadOrUnmapCpu: new RollingStats(),
  cpuTotal: new RollingStats(),
  iterWall: new RollingStats(),
};

let pinnedBaseline = null;

export const paneMetrics = {
  get samples() {
    return `${stats.iterWall.count}`;
  },
  get uploadedSize() {
    if (!runtimeState.decodedBytes) return '-';
    return `${(runtimeState.decodedBytes / 1e6).toFixed(3)} MB`;
  },
  get cpuTotal_GBps() {
    return stats.cpuTotal.formatGBps(runtimeState.decodedBytes);
  },
  get uploadStep_GBps() {
    if (config.uploadMethod === 'mmap') {
      return 'zero-copy (mmap)';
    }
    return stats.uploadOrUnmapCpu.formatGBps(runtimeState.decodedBytes);
  },
  get streamTotal_GBps() {
    return stats.iterWall.formatGBps(runtimeState.decodedBytes);
  },
  get mmapSetup_ms() {
    return stats.mmapSetupCpu.formatMs();
  },
  get wasmDecode_ms() {
    return stats.wasmDecodeCpu.formatMs();
  },
  get uploadOrUnmap_ms() {
    return stats.uploadOrUnmapCpu.formatMs();
  },
  get cpuTotal_ms() {
    return stats.cpuTotal.formatMs();
  },
  get iterWall_ms() {
    return stats.iterWall.formatMs();
  },
};

const fTiming = pane.addFolder({ title: 'Bandwidth & Timing (GB/s \u00b1 SEM)' });
fTiming.addBinding(paneMetrics, 'samples', { readonly: true });
fTiming.addBinding(paneMetrics, 'uploadedSize', { readonly: true });
fTiming.addBlade({ view: 'separator' });
fTiming.addBinding(paneMetrics, 'cpuTotal_GBps', {
  label: 'decode+upload',
  readonly: true,
});
fTiming.addBinding(paneMetrics, 'uploadStep_GBps', {
  label: 'upload step',
  readonly: true,
});
fTiming.addBinding(paneMetrics, 'streamTotal_GBps', {
  label: 'sustained stream',
  readonly: true,
});
fTiming.addBlade({ view: 'separator' });
fTiming.addBinding(paneMetrics, 'mmapSetup_ms', { readonly: true });
fTiming.addBinding(paneMetrics, 'wasmDecode_ms', { readonly: true });
fTiming.addBinding(paneMetrics, 'uploadOrUnmap_ms', { readonly: true });
fTiming.addBinding(paneMetrics, 'cpuTotal_ms', { readonly: true });
fTiming.addBinding(paneMetrics, 'iterWall_ms', { readonly: true });

export function resetStats() {
  for (const s of Object.values(stats)) {
    s.reset();
  }
  renderReadout();
}

export function resetIfNeeded(fn) {
  if (needReset) {
    commitConfig();
    fn();
    needReset = false;
  }
}

const readoutEl = document.getElementById('perf-readout');
const statusBadgeEl = document.getElementById('status-badge');
const btnCopy = document.getElementById('btn-copy');
const btnBaseline = document.getElementById('btn-baseline');
const btnClearBaseline = document.getElementById('btn-clear-baseline');
const btnReset = document.getElementById('btn-reset');

export function forcePauseFromError() {
  pauseConfig.pause = true;
  pane.refresh();
  updateStatusBadge();
}

export function updateStatusBadge() {
  const n = stats.iterWall.count;
  const relSem = (() => {
    const { mean, sem, n: cnt } = stats.cpuTotal.getMeanAndSem();
    if (cnt < 2 || !(mean > 0)) return null;
    return ((sem / mean) * 100).toFixed(2);
  })();

  if (pauseConfig.pause) {
    statusBadgeEl.textContent = `Paused (${n} samples${relSem ? `, \u00b1${relSem}% rel. SEM` : ''})`;
    statusBadgeEl.classList.add('paused');
  } else {
    statusBadgeEl.textContent =
      `Streaming continuously... (${n} samples${relSem ? `, \u00b1${relSem}% rel. SEM` : ''}, ` +
      `${runtimeState.inFlightFetches} fetches in flight, ${runtimeState.readyPayloads} ready)`;
    statusBadgeEl.classList.remove('paused');
  }
}

function padRight(str, width) {
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

export function buildSummaryText() {
  const asset = ASSETS[config.assetKey];
  const bytes = runtimeState.decodedBytes;
  const compMB = runtimeState.compressedBytes
    ? `${(runtimeState.compressedBytes / 1e6).toFixed(3)} MB`
    : '-';
  const upMB = bytes ? `${(bytes / 1e6).toFixed(3)} MB` : '-';
  const n = stats.iterWall.count;

  const uploadStepLine =
    config.uploadMethod === 'mmap'
      ? `${stats.uploadOrUnmapCpu.formatGBps(bytes)}  (unmap + cmd only; 0 CPU copies)`
      : stats.uploadOrUnmapCpu.formatGBps(bytes);

  const lines = [
    `mode                      ${UPLOAD_MODE_LABELS[config.uploadMethod]}`,
    `asset                     ${asset.url} (${runtimeState.width}x${runtimeState.height} ${asset.codec}, ${compMB} compressed)`,
    `gpuFormat                 ${config.targetFormat} (${upMB} uploaded per texture)`,
    `doWasmDecode              ${config.doWasmDecode} | highPrecisionTimestamps: ${window.crossOriginIsolated}`,
    `samples                   ${n} (window=${config.maxSamples}, fetchPipeline=${config.fetchPipelineDepth}, uploadPool=${runtimeState.poolAvailable}/${runtimeState.poolTotal})`,
    ``,
    `--- Throughput (GB/s \u00b1 SEM, based on ${upMB} uploaded texture payload) ---`,
    `${padRight('decodePlusUpload_bw', 26)}${stats.cpuTotal.formatGBps(bytes)}`,
    `${padRight('uploadOrUnmap_bw', 26)}${uploadStepLine}`,
    `${padRight('sustainedStream_bw', 26)}${stats.iterWall.formatGBps(bytes)}`,
    ``,
    `--- Fine Timing Breakdown (ms \u00b1 SEM per streamed texture) ---`,
    `${padRight('fetchQueue_waitTime', 26)}${stats.fetchWait.formatMs()}`,
    `${padRight('acquireBuffer_waitTime', 26)}${stats.acquireWait.formatMs()}`,
    `${padRight('stageInput_cpuTime', 26)}${stats.stageInputCpu.formatMs()}`,
    `${padRight('mmapBuffer_cpuTime', 26)}${stats.mmapSetupCpu.formatMs()}`,
    `${padRight('wasmDecode_cpuTime', 26)}${stats.wasmDecodeCpu.formatMs()}`,
    `${padRight('uploadOrUnmap_cpuTime', 26)}${stats.uploadOrUnmapCpu.formatMs()}`,
    `${padRight('cpuTotal_cpuTime', 26)}${stats.cpuTotal.formatMs()}`,
    `${padRight('iter_wallTime', 26)}${stats.iterWall.formatMs()}`,
  ];

  if (pinnedBaseline && bytes > 0 && n > 0) {
    const curBw = stats.cpuTotal.getBandwidthStats(bytes);
    const curCpu = stats.cpuTotal.getMeanAndSem();
    const curStream = stats.iterWall.getBandwidthStats(bytes);
    const bwGainPct =
      pinnedBaseline.cpuBwMean > 0
        ? (((curBw.bwMean - pinnedBaseline.cpuBwMean) / pinnedBaseline.cpuBwMean) * 100).toFixed(1)
        : 'n/a';
    const streamGainPct =
      pinnedBaseline.streamBwMean > 0
        ? (((curStream.bwMean - pinnedBaseline.streamBwMean) / pinnedBaseline.streamBwMean) * 100).toFixed(1)
        : 'n/a';
    const msSaved = (pinnedBaseline.cpuMsMean - curCpu.mean).toFixed(3);

    lines.push(
      ``,
      `--- Comparison vs. Pinned Baseline [${pinnedBaseline.label}] ---`,
      `${padRight('baseline decode+upload', 26)}${pinnedBaseline.cpuBwStr} (${pinnedBaseline.cpuMsStr})`,
      `${padRight('baseline sustainedStream', 26)}${pinnedBaseline.streamBwStr}`,
      `${padRight('delta decode+upload', 26)}${Number(bwGainPct) >= 0 ? '+' : ''}${bwGainPct}% GB/s (${msSaved} ms CPU saved / texture)`,
      `${padRight('delta sustainedStream', 26)}${Number(streamGainPct) >= 0 ? '+' : ''}${streamGainPct}% GB/s`
    );
  }

  return lines.join('\n');
}

let lastUiRefreshTime = 0;
export function renderReadout(force = false) {
  const now = performance.now();
  if (!force && now - lastUiRefreshTime < 100) {
    return;
  }
  lastUiRefreshTime = now;
  updateStatusBadge();
  readoutEl.textContent = buildSummaryText();
  pane.refresh();
}

btnCopy.addEventListener('click', async () => {
  const text = buildSummaryText();
  await navigator.clipboard.writeText(text);
  const orig = btnCopy.textContent;
  btnCopy.textContent = 'Copied!';
  setTimeout(() => {
    btnCopy.textContent = orig;
  }, 1400);
});

btnBaseline.addEventListener('click', () => {
  const bytes = runtimeState.decodedBytes;
  if (!bytes || stats.cpuTotal.count === 0) return;
  const cpuBw = stats.cpuTotal.getBandwidthStats(bytes);
  const streamBw = stats.iterWall.getBandwidthStats(bytes);
  const cpuMs = stats.cpuTotal.getMeanAndSem();
  pinnedBaseline = {
    label: `${config.uploadMethod} | ${config.assetKey} | ${config.targetFormat} (N=${stats.cpuTotal.count})`,
    cpuBwMean: cpuBw.bwMean,
    cpuBwStr: stats.cpuTotal.formatGBps(bytes),
    streamBwMean: streamBw.bwMean,
    streamBwStr: stats.iterWall.formatGBps(bytes),
    cpuMsMean: cpuMs.mean,
    cpuMsStr: stats.cpuTotal.formatMs(),
  };
  btnClearBaseline.hidden = false;
  renderReadout(true);
});

btnClearBaseline.addEventListener('click', () => {
  pinnedBaseline = null;
  btnClearBaseline.hidden = true;
  renderReadout(true);
});

btnReset.addEventListener('click', () => {
  resetStats();
  renderReadout(true);
});
