// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The frame as a texture, drawn by a fullscreen triangle.
 *
 * WebGPU is optional everywhere, so every failure here is a reason to fall
 * back to the 2D renderer rather than to stop: the caller is told through a
 * null result or the `lost` callback.
 */

import { Frame, Rect, Renderer } from "./render.ts";

const SHADER = `
struct Varying {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vertex(@builtin(vertex_index) index: u32) -> Varying {
  // One triangle covering the viewport, so no vertex buffer is needed.
  var points = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let point = points[index];
  var out: Varying;
  out.position = vec4f(point, 0.0, 1.0);
  out.uv = vec2f((point.x + 1.0) * 0.5, (1.0 - point.y) * 0.5);
  return out;
}

@group(0) @binding(0) var frame: texture_2d<f32>;
@group(0) @binding(1) var frameSampler: sampler;

@fragment
fn fragment(in: Varying) -> @location(0) vec4f {
  return textureSample(frame, frameSampler, in.uv);
}
`;

export class GpuRenderer implements Renderer {
  smooth = false;
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly pipeline: GPURenderPipeline;
  private readonly samplers: { nearest: GPUSampler; linear: GPUSampler };
  private texture: GPUTexture | null = null;
  private bindGroup: GPUBindGroup | null = null;
  /** Which sampler `bindGroup` holds, since the choice is the caller's. */
  private filtered = false;
  private width = 0;
  private height = 0;

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    pipeline: GPURenderPipeline,
    samplers: { nearest: GPUSampler; linear: GPUSampler },
  ) {
    this.device = device;
    this.context = context;
    this.pipeline = pipeline;
    this.samplers = samplers;
  }

  /** Returns null when the browser cannot give us a device or a context. */
  static async create(
    canvas: HTMLCanvasElement,
    lost: (reason: string) => void,
  ): Promise<GpuRenderer | null> {
    if (!navigator.gpu) return null;
    let device: GPUDevice;
    let context: GPUCanvasContext;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      device = await adapter.requestDevice();
      const found = canvas.getContext("webgpu");
      if (!found) return null;
      context = found as unknown as GPUCanvasContext;
      context.configure({
        device,
        format: navigator.gpu.getPreferredCanvasFormat(),
        alphaMode: "opaque",
      });
    } catch (error) {
      lost(error instanceof Error ? error.message : String(error));
      return null;
    }
    device.lost.then((info) => lost(info.message || "the GPU device was lost"));
    const shader = device.createShaderModule({ code: SHADER });
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: shader, entryPoint: "vertex" },
      fragment: {
        module: shader,
        entryPoint: "fragment",
        targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
      },
      primitive: { topology: "triangle-list" },
    });
    const samplers = {
      nearest: device.createSampler({
        magFilter: "nearest",
        minFilter: "nearest",
      }),
      linear: device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
      }),
    };
    return new GpuRenderer(device, context, pipeline, samplers);
  }

  resize(): void {
    // The context follows the canvas's own size.
  }

  update(frame: Frame): void {
    if (frame.width !== this.width || frame.height !== this.height) {
      this.texture?.destroy();
      this.width = frame.width;
      this.height = frame.height;
      this.texture = this.device.createTexture({
        size: [frame.width, frame.height],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.bindGroup = null;
    }
    if (!this.texture) return;
    if (!this.bindGroup || this.filtered !== this.smooth) {
      this.filtered = this.smooth;
      this.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.texture.createView() },
          {
            binding: 1,
            resource: this.filtered
              ? this.samplers.linear
              : this.samplers.nearest,
          },
        ],
      });
    }
    // A tightly packed RGBA frame needs no row alignment through writeTexture.
    this.device.queue.writeTexture(
      { texture: this.texture },
      frame.rgba,
      { bytesPerRow: frame.width * 4, rowsPerImage: frame.height },
      { width: frame.width, height: frame.height },
    );
  }

  draw(target: Rect): void {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    if (this.bindGroup && target.width > 0 && target.height > 0) {
      pass.setViewport(target.x, target.y, target.width, target.height, 0, 1);
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.draw(3);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.texture?.destroy();
    this.texture = null;
    this.bindGroup = null;
    this.device.destroy();
  }
}
