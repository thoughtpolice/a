// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** What a browser renderer is handed, and where it is asked to put it. */

export interface Frame {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** A rectangle in the canvas's device pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Renderer {
  /**
   * Whether to filter the frame where it does not land on whole pixels. Art
   * drawn a pixel at a time wants the hard edges kept; a frame already near
   * the canvas's own size is not that, and nearest neighbour at a fractional
   * scale is what looks wrong on it.
   */
  smooth: boolean;
  /** The canvas's device-pixel size changed. */
  resize(width: number, height: number): void;
  /** A new frame was presented; the pixels belong to the caller. */
  update(frame: Frame): void;
  /** Draws the last frame into `target`, clearing the rest. */
  draw(target: Rect): void;
  destroy(): void;
}

/**
 * Where a frame goes inside a canvas, centred in what is left over: the
 * terminal's 4:3 box, square pixels scaled by whole numbers, or square pixels
 * scaled to whatever fits.
 *
 * Whole numbers keep a small frame's pixels even, which is what a cart drawn
 * a pixel at a time wants. It costs a frame already near the canvas's own
 * size far more than it is worth -- 1.9 rounds down to 1 and throws away
 * three quarters of the screen -- and the evenness buys such a frame nothing,
 * so `fill` scales those to fit instead.
 */
export function fit(
  frame: { width: number; height: number },
  canvas: { width: number; height: number },
  aspect: "4:3" | "frame" | "fill",
): Rect {
  if (frame.width === 0 || frame.height === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const ratio = aspect === "4:3" ? 4 / 3 : frame.width / frame.height;
  let width = canvas.width;
  let height = Math.round(width / ratio);
  if (height > canvas.height) {
    height = canvas.height;
    width = Math.round(height * ratio);
  }
  // Below a whole multiple of the frame, scaling by a whole number would waste
  // more than it gains, so only an exact fit is snapped.
  const scale = Math.floor(
    Math.min(width / frame.width, height / frame.height),
  );
  if (aspect === "frame" && scale >= 1) {
    width = frame.width * scale;
    height = frame.height * scale;
  }
  return {
    x: Math.floor((canvas.width - width) / 2),
    y: Math.floor((canvas.height - height) / 2),
    width,
    height,
  };
}
