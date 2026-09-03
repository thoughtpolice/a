// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** The renderer every browser has: the frame through a 2D context. */

import { Frame, Rect, Renderer } from "./render.ts";

export class Canvas2dRenderer implements Renderer {
  smooth = false;
  private readonly context: CanvasRenderingContext2D;
  private source: OffscreenCanvas | HTMLCanvasElement | null = null;
  private sourceContext:
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null = null;
  private image: ImageData | null = null;
  private width = 0;
  private height = 0;

  private constructor(context: CanvasRenderingContext2D) {
    this.context = context;
  }

  static create(canvas: HTMLCanvasElement): Canvas2dRenderer | null {
    const context = canvas.getContext("2d", { alpha: false });
    return context ? new Canvas2dRenderer(context) : null;
  }

  resize(): void {
    // The context follows the canvas; nothing of its own depends on the size.
  }

  update(frame: Frame): void {
    if (frame.width !== this.width || frame.height !== this.height) {
      this.width = frame.width;
      this.height = frame.height;
      this.source = typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(frame.width, frame.height)
        : Object.assign(document.createElement("canvas"), {
          width: frame.width,
          height: frame.height,
        });
      this.sourceContext = (this.source as HTMLCanvasElement).getContext("2d", {
        alpha: false,
      }) as CanvasRenderingContext2D | null;
      this.image = new ImageData(frame.width, frame.height);
    }
    this.image?.data.set(frame.rgba);
    if (this.image) this.sourceContext?.putImageData(this.image, 0, 0);
  }

  draw(target: Rect): void {
    const canvas = this.context.canvas;
    this.context.fillStyle = "#000";
    this.context.fillRect(0, 0, canvas.width, canvas.height);
    if (!this.source || target.width === 0 || target.height === 0) return;
    // A cart's frame is scaled by a lot, and smoothing turns its pixel art
    // to mud; a frame drawn at nearly the canvas's own size is not pixel art.
    this.context.imageSmoothingEnabled = this.smooth;
    this.context.drawImage(
      this.source as CanvasImageSource,
      target.x,
      target.y,
      target.width,
      target.height,
    );
  }

  destroy(): void {
    this.source = null;
    this.sourceContext = null;
    this.image = null;
  }
}
