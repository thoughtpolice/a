// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** What a packaged console application says about itself. */

export interface Mount {
  path: string;
  file: string;
  size: number;
}

export interface Manifest {
  name: string;
  title: string;
  module: string;
  framesPerSecond: number;
  /**
   * How a frame is shaped on screen: the terminal's 4:3 box, square pixels by
   * whole multiples, or square pixels at whatever scale fits.
   */
  aspect: "4:3" | "frame" | "fill";
  /** The runner option that replaces the single mount, as `--iwad` does. */
  option: string | null;
  args: string[];
  mounts: Mount[];
}

function fail(message: string): never {
  throw new Error(`manifest.json: ${message}`);
}

function field(record: Record<string, unknown>, name: string): unknown {
  const value = record[name];
  if (value === undefined) fail(`missing ${name}`);
  return value;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") fail(`${name} is not a string`);
  return value;
}

function asCount(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    fail(`${name} is not a positive integer`);
  }
  return value;
}

/** Reads a manifest, refusing anything the runner and the browser cannot honour. */
export function parseManifest(value: unknown): Manifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("expected an object");
  }
  const record = value as Record<string, unknown>;
  const aspect = asString(field(record, "aspect"), "aspect");
  if (aspect !== "4:3" && aspect !== "frame" && aspect !== "fill") {
    fail(`aspect ${aspect} is not 4:3, frame or fill`);
  }

  const rawOption = field(record, "option");
  const option = rawOption === null ? null : asString(rawOption, "option");

  const rawArgs = field(record, "args");
  if (!Array.isArray(rawArgs)) fail("args is not a list");
  const args = rawArgs.map((arg, index) => asString(arg, `args[${index}]`));

  const rawMounts = field(record, "mounts");
  if (!Array.isArray(rawMounts)) fail("mounts is not a list");
  const mounts = rawMounts.map((mount, index) => {
    if (typeof mount !== "object" || mount === null) {
      fail(`mounts[${index}] is not an object`);
    }
    const entry = mount as Record<string, unknown>;
    const size = field(entry, "size");
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
      fail(`mounts[${index}].size is not a byte count`);
    }
    return {
      path: asString(field(entry, "path"), `mounts[${index}].path`),
      file: asString(field(entry, "file"), `mounts[${index}].file`),
      size,
    };
  });
  if (option !== null && mounts.length !== 1) {
    fail(`option ${option} needs exactly one mount to replace`);
  }

  return {
    name: asString(field(record, "name"), "name"),
    title: asString(field(record, "title"), "title"),
    module: asString(field(record, "module"), "module"),
    framesPerSecond: asCount(
      field(record, "frames_per_second"),
      "frames_per_second",
    ),
    aspect,
    option,
    args,
    mounts,
  };
}
