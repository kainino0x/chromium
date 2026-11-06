Live [here](https://kai.graphics/webgpu-wasm-map-benchmark/) (but note that it doesn't have
site isolation so it won't use high-precision timestamps).

## Local setup

Run:

```sh
npm ci
npm start  # Uses site isolation for high-precision timestamps
```

Rebuild the AssemblyScript part (only needed after changes to `assembly/*`):

```sh
npm run build
```

## KTX2 Wasm &rarr; WebGPU Streaming Upload Benchmark (`ktx2.html`)

Open `http://127.0.0.1:8080/ktx2.html` after running `npm start`. Launch the prototype Chromium build with `--js-flags="--experimental-wasm-memory-control --wasm-memory-map-persistent"` to enable `GPUBuffer.prototype.getMMapDescriptor` with persistent memory mappings (and `--disable-features=UsePersistentCacheForCodeCache` or a fresh `--user-data-dir` on `dcheck_always_on=true` builds if needed). You can also preselect options via URL parameters such as `?mode=mmap&asset=env_4096_etc1s&format=rgba8unorm&preview=false`.

This benchmark streams large 4096&times;4096 and 8192&times;8192 KTX2 (ETC1S and UASTC+Zstd) textures encoded from `KhronosGroup/glTF-Sample-Environments` via a concurrent pipeline of cache-busted HTTP `fetch` requests, transcodes them in WebAssembly using a thin C++ Basis Universal + Zstd transcoder (`wasm_ktx2/ktx2_decoder.cpp`), and uploads them to a WebGPU `GPUTexture` across four runtime modes:

- **`copy`**: Transcodes into Wasm heap, copies into `GPUBuffer.getMappedRange()` via `TypedArray.set()`, calls `uploadBuffer.unmap()`, and submits `copyBufferToTexture`.
- **`mmap`**: Maps the `GPUBuffer` directly into Wasm linear memory via `uploadBuffer.getMMapDescriptor(0, size).map(wasmMemory, ptr)`, transcodes directly into `ptr` with zero CPU memcpy, calls `uploadBuffer.unmap()`, and submits `copyBufferToTexture`.
- **`writeTexture`**: Transcodes into Wasm heap and calls `device.queue.writeTexture`.
- **`writeBuffer`**: Transcodes into Wasm heap, calls `device.queue.writeBuffer`, and submits `copyBufferToTexture`.

Throughput (`GB/s ± SEM`) and fine-grained CPU/wall timing (`ms ± SEM`) are updated continuously on screen in a copyable summary block and in Tweakpane, with support for pinning a baseline to compare modes directly.

To rebuild the C++ KTX2 Wasm transcoder (`build/ktx2_decoder.{js,wasm}`):

```sh
npm run build:ktx2
```

## About this benchmark

This is a benchmark (or really, perf exploration tool) for looking at Wasm->WebGPU and WebGPU->Wasm
data copy performance and prototyping optimization features.

It runs a continuous pipeline of alternating CPU and GPU operations on the same data, copying back
and forth between each operation. The CPU and GPU operations themselves are (for now) as trivial as
possible so that the memcpy performance is easy to see. In a real application they would be more
intensive operations, like ops in a neural network.

It is mostly just JS, with a tiny bit of AssemblyScript for the Wasm part.
(That can be replaced with something else if AssemblyScript isn't suitable.)
