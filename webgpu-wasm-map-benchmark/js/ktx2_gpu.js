// Manages the destination GPUTexture, the staging GPUBuffer (for writeBuffer
// mode), and a lightweight preview render pipeline to display each uploaded
// KTX2 texture on the canvas.

import { device, ctx, canvas, canvasFormat } from './ktx2_device.js';

const previewUbo = device.createBuffer({
  label: 'ktx2 preview ubo',
  size: 16,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
});

const sampler = device.createSampler({
  magFilter: 'linear',
  minFilter: 'linear',
});

const bgl = device.createBindGroupLayout({
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: 'uniform' },
    },
    {
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: 'filtering' },
    },
    {
      binding: 2,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: 'float' },
    },
  ],
});

const shaderModule = device.createShaderModule({
  label: 'ktx2 preview shader',
  code: `
    struct Params {
      frameNum: u32,
      texWidth: u32,
      texHeight: u32,
      _pad: u32,
    }
    @group(0) @binding(0) var<uniform> params: Params;
    @group(0) @binding(1) var samp: sampler;
    @group(0) @binding(2) var tex: texture_2d<f32>;

    struct VSOut {
      @builtin(position) pos: vec4f,
      @location(0) uv: vec2f,
    }

    @vertex
    fn vmain(@builtin(vertex_index) vi: u32) -> VSOut {
      const positions = array(
        vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
        vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
      );
      let p = positions[vi];
      var out: VSOut;
      out.pos = vec4f(p, 0.0, 1.0);
      out.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
      return out;
    }

    @fragment
    fn fmain(in: VSOut) -> @location(0) vec4f {
      var color = textureSample(tex, samp, in.uv);
      // Subtle 6px progress bar along bottom edge showing continuous frame updates.
      if (in.uv.y > 0.994) {
        let progress = fract(f32(params.frameNum) / 120.0);
        if (in.uv.x < progress) {
          color = vec4f(0.51, 0.79, 0.58, 1.0);
        } else {
          color = vec4f(0.12, 0.14, 0.18, 1.0);
        }
      }
      return vec4f(color.rgb, 1.0);
    }
  `,
});

const renderPipeline = device.createRenderPipeline({
  layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
  vertex: { module: shaderModule, entryPoint: 'vmain' },
  fragment: {
    module: shaderModule,
    entryPoint: 'fmain',
    targets: [{ format: canvasFormat }],
  },
  primitive: { topology: 'triangle-list' },
});

let currentTexture = null;
let currentBindGroup = null;
let currentStagingBuffer = null;
let currentKey = '';

export const Ktx2GPU = {
  get texture() {
    return currentTexture;
  },

  get stagingBuffer() {
    return currentStagingBuffer;
  },

  ensureResources(layout) {
    const key = `${layout.width}x${layout.height}:${layout.webgpuFormat}:${layout.alignedBufferBytes}`;
    if (key === currentKey && currentTexture && currentStagingBuffer) {
      return;
    }
    currentKey = key;

    // Keep preview canvas lightweight (1024x1024) so rasterization never
    // bottlenecks 4K/8K upload throughput measurements.
    const previewSize = 1024;
    if (canvas.width !== previewSize || canvas.height !== previewSize) {
      canvas.width = previewSize;
      canvas.height = previewSize;
    }

    if (currentTexture) {
      currentTexture.destroy();
    }
    currentTexture = device.createTexture({
      label: `ktx2 dst texture ${layout.width}x${layout.height} (${layout.webgpuFormat})`,
      size: [layout.width, layout.height, 1],
      format: layout.webgpuFormat,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });

    if (currentStagingBuffer) {
      currentStagingBuffer.destroy();
    }
    currentStagingBuffer = device.createBuffer({
      label: `ktx2 writeBuffer staging (${(layout.alignedBufferBytes / (1024 * 1024)).toFixed(1)} MiB)`,
      size: layout.alignedBufferBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    currentBindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: previewUbo } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: currentTexture.createView() },
      ],
    });
  },

  encodePreviewPass(commandEncoder, layout, frameNum) {
    device.queue.writeBuffer(
      previewUbo,
      0,
      new Uint32Array([frameNum, layout.width, layout.height, 0])
    );
    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: ctx.getCurrentTexture().createView(),
          clearValue: [0.03, 0.04, 0.05, 1.0],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(renderPipeline);
    pass.setBindGroup(0, currentBindGroup);
    pass.draw(6);
    pass.end();
  },
};
