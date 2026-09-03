// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The virtual root the HAL's file functions operate on.
 *
 * Paths are slash-separated names whose segments are never empty, `.`, or
 * `..`; they never select a host file. Writable entries are mirrored through a
 * {@link Mirror} when the host has somewhere to keep them, which is the only
 * difference between a session that forgets its files and one that does not.
 */

export const MAX_HANDLES = 128;
export const MAX_NAME = 256;
export const MAX_RAM_FILE = 64 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Entry {
  name: string;
  /** The UTF-8 of `name`; entries are ordered and compared as the native host orders bytes. */
  nameBytes: Uint8Array;
  data: Uint8Array;
  size: number;
  readonly: boolean;
  directory: boolean;
  removed: boolean;
  dirty: boolean;
  openCount: number;
}

interface Handle {
  entry: number;
  writable: boolean;
}

/** A listed directory entry, as `file-list-directory` returns it. */
export interface Listing {
  name: string;
  size: number;
  directory: boolean;
}

/** Where writable entries are kept so they outlast the run. */
export interface Mirror {
  write(name: string, bytes: Uint8Array): void;
  remove(name: string, directory: boolean): void;
  rename(from: string, to: string): void;
  mkdir(name: string): void;
}

/** A host with nowhere to keep files: everything lives for the session only. */
export const NoMirror: Mirror = {
  write(): void {},
  remove(): void {},
  rename(): void {},
  mkdir(): void {},
};

/** A mirror that remembers what it was asked to do, and can refuse. */
export class RecordingMirror implements Mirror {
  readonly calls: string[] = [];
  /** When set, every call throws this message instead of recording. */
  failure: string | null = null;

  private record(call: string): void {
    if (this.failure !== null) throw new Error(`${call}: ${this.failure}`);
    this.calls.push(call);
  }

  write(name: string, bytes: Uint8Array): void {
    this.record(`write ${name} ${bytes.length}`);
  }

  remove(name: string, directory: boolean): void {
    this.record(`remove ${name} ${directory}`);
  }

  rename(from: string, to: string): void {
    this.record(`rename ${from} ${to}`);
  }

  mkdir(name: string): void {
    this.record(`mkdir ${name}`);
  }
}

/**
 * A path in the virtual root: leading `./` stripped, slash-separated segments
 * none of which is empty, `.`, or `..`, and shorter than 256 bytes. A path the
 * platform could not have produced, because it is not UTF-8, is refused: it
 * has no representation here.
 */
export function fileName(bytes: Uint8Array): string | null {
  let start = 0;
  while (
    bytes.length - start >= 2 && bytes[start] === 0x2e &&
    bytes[start + 1] === 0x2f
  ) {
    start += 2;
  }
  const path = bytes.subarray(start);
  if (path.length === 0 || path.length >= MAX_NAME) return null;
  let segment = 0;
  for (let i = 0; i <= path.length; i++) {
    const byte = i < path.length ? path[i] : 0x2f;
    if (byte === 0 || byte === 0x5c) return null;
    if (byte !== 0x2f) {
      segment++;
      continue;
    }
    if (segment === 0) return null;
    if (segment === 1 && path[i - 1] === 0x2e) return null;
    if (segment === 2 && path[i - 2] === 0x2e && path[i - 1] === 0x2e) {
      return null;
    }
    segment = 0;
  }
  const name = decoder.decode(path);
  const round = encoder.encode(name);
  if (round.length !== path.length) return null;
  for (let i = 0; i < round.length; i++) {
    if (round[i] !== path[i]) return null;
  }
  return name;
}

/** A directory is named like a file, except that the root is the empty path or `.`. */
export function directoryName(bytes: Uint8Array): string | null {
  let start = 0;
  while (
    bytes.length - start >= 2 && bytes[start] === 0x2e &&
    bytes[start + 1] === 0x2f
  ) {
    start += 2;
  }
  const path = bytes.subarray(start);
  if (path.length === 0 || (path.length === 1 && path[0] === 0x2e)) return "";
  return fileName(path);
}

/**
 * Orders names as `strcmp` orders their UTF-8. JavaScript compares strings by
 * UTF-16 code unit, which puts the supplementary planes before U+E000; the
 * host sorts directory listings by byte, so compare by code point instead.
 */
export function compareCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const common = Math.min(left.length, right.length);
  for (let i = 0; i < common; i++) {
    const x = left[i].codePointAt(0) ?? 0;
    const y = right[i].codePointAt(0) ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

function grow(entry: Entry, size: number): void {
  if (size <= entry.data.length) return;
  let capacity = entry.data.length || 64;
  while (capacity < size) capacity *= 2;
  const data = new Uint8Array(capacity);
  data.set(entry.data.subarray(0, entry.size));
  entry.data = data;
}

export class Vfs {
  private entries: Entry[] = [];
  private handles: (Handle | null)[] = new Array(MAX_HANDLES).fill(null);
  private mirror: Mirror = NoMirror;
  /** The first failure to keep a change, reported once after the run. */
  saveError: string | null = null;

  /** Directs writable entries at `mirror`; mounts made before this are untouched. */
  setMirror(mirror: Mirror): void {
    this.mirror = mirror;
  }

  hasMirror(): boolean {
    return this.mirror !== NoMirror;
  }

  private failed(what: string, error: unknown): void {
    if (this.saveError !== null) return;
    const message = error instanceof Error ? error.message : String(error);
    this.saveError = `${what} ${message}`;
  }

  private find(name: string): number {
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry.name !== "" && !entry.removed && entry.name === name) return i;
    }
    return -1;
  }

  private add(name: string, directory: boolean): number {
    const entry: Entry = {
      name,
      nameBytes: encoder.encode(name),
      data: new Uint8Array(0),
      size: 0,
      readonly: false,
      directory,
      removed: false,
      dirty: false,
      openCount: 0,
    };
    for (let i = 0; i < this.entries.length; i++) {
      if (this.entries[i].name === "") {
        this.entries[i] = entry;
        return i;
      }
    }
    this.entries.push(entry);
    return this.entries.length - 1;
  }

  private release(index: number): void {
    this.entries[index] = {
      name: "",
      nameBytes: new Uint8Array(0),
      data: new Uint8Array(0),
      size: 0,
      readonly: false,
      directory: false,
      removed: false,
      dirty: false,
      openCount: 0,
    };
  }

  private addDirectory(name: string): number {
    const index = this.add(name, true);
    try {
      this.mirror.mkdir(name);
    } catch (error) {
      this.failed("creating", error);
    }
    return index;
  }

  /** Every directory on a name's path exists, created as needed; a file in the way fails. */
  private ensureParents(name: string): boolean {
    for (let at = name.indexOf("/"); at >= 0; at = name.indexOf("/", at + 1)) {
      const parent = name.slice(0, at);
      const existing = this.find(parent);
      if (existing >= 0) {
        if (!this.entries[existing].directory) return false;
      } else {
        this.addDirectory(parent);
      }
    }
    return true;
  }

  private childOf(entry: Entry, dir: string): boolean {
    if (entry.name === "" || entry.removed) return false;
    let rest = entry.name;
    if (dir !== "") {
      if (!entry.name.startsWith(dir) || entry.name[dir.length] !== "/") {
        return false;
      }
      rest = entry.name.slice(dir.length + 1);
    }
    return !rest.includes("/");
  }

  private hasChildren(dir: string): boolean {
    return this.entries.some((entry) => this.childOf(entry, dir));
  }

  private children(dir: string): number[] {
    const indexes: number[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      if (this.childOf(this.entries[i], dir)) indexes.push(i);
    }
    indexes.sort((a, b) =>
      compareCodePoints(this.entries[a].name, this.entries[b].name)
    );
    return indexes;
  }

  private flush(index: number): void {
    const entry = this.entries[index];
    if (!this.hasMirror() || entry.directory || entry.removed || !entry.dirty) {
      return;
    }
    entry.dirty = false;
    try {
      this.mirror.write(entry.name, entry.data.subarray(0, entry.size));
    } catch (error) {
      this.failed("writing", error);
    }
  }

  /** Writes every entry the guest changed; the run's last act. */
  flushAll(): void {
    for (let i = 0; i < this.entries.length; i++) {
      if (this.entries[i].name !== "") this.flush(i);
    }
  }

  private mirrorRemove(entry: Entry): void {
    if (!this.hasMirror()) return;
    try {
      this.mirror.remove(entry.name, entry.directory);
    } catch (error) {
      this.failed("removing", error);
    }
  }

  /** Mounts read-only bytes at `path`, as a runner mounts a game's assets. */
  mountReadonly(path: string, data: Uint8Array): boolean {
    const name = fileName(encoder.encode(path));
    if (name === null || this.find(name) >= 0 || !this.ensureParents(name)) {
      return false;
    }
    const index = this.add(name, false);
    const entry = this.entries[index];
    entry.data = data;
    entry.size = data.length;
    entry.readonly = true;
    return true;
  }

  /**
   * Puts a mirrored entry into the root, below the mounts. Returns the message
   * a host prints when the entry cannot be represented, or null on success.
   */
  loadEntry(
    name: string,
    directory: boolean,
    data: Uint8Array | null,
  ): string | null {
    const existing = this.find(name);
    if (existing >= 0) {
      if (directory && this.entries[existing].directory) return null;
      return "a mounted asset is in the way, skipped";
    }
    const index = this.add(name, directory);
    if (!directory && data) {
      this.entries[index].data = data;
      this.entries[index].size = data.length;
    }
    return null;
  }

  /** The bytes of an entry, for tests and for a host that inspects the root. */
  read(name: string): Uint8Array | null {
    const index = this.find(name);
    if (index < 0 || this.entries[index].directory) return null;
    return this.entries[index].data.subarray(0, this.entries[index].size);
  }

  private handleEntry(fd: number): number {
    const handle = fd < MAX_HANDLES ? this.handles[fd] : null;
    return handle ? handle.entry : -1;
  }

  open(path: Uint8Array, write: boolean): number {
    const name = fileName(path);
    if (name === null) return -1;
    let fd = 0;
    while (fd < MAX_HANDLES && this.handles[fd] !== null) fd++;
    if (fd === MAX_HANDLES) return -1;
    let index = this.find(name);
    if (index < 0 && write && this.ensureParents(name)) {
      index = this.add(name, false);
    }
    if (index < 0) return -1;
    const entry = this.entries[index];
    if (entry.directory || (write && entry.readonly)) return -1;
    if (write) {
      entry.data = new Uint8Array(0);
      entry.size = 0;
      entry.dirty = true;
    }
    entry.openCount++;
    this.handles[fd] = { entry: index, writable: write };
    return fd;
  }

  size(fd: number): number {
    const index = this.handleEntry(fd);
    return index < 0 ? -1 : this.entries[index].size;
  }

  readAt(
    fd: number,
    offset: bigint,
    length: number,
  ): { status: number; data: Uint8Array } {
    const index = this.handleEntry(fd);
    if (index < 0) return { status: -1, data: new Uint8Array(0) };
    const entry = this.entries[index];
    const size = BigInt(entry.size);
    if (offset >= size) return { status: 0, data: new Uint8Array(0) };
    const start = Number(offset);
    const take = Math.min(entry.size - start, length);
    return { status: 0, data: entry.data.subarray(start, start + take) };
  }

  writeAt(fd: number, offset: bigint, data: Uint8Array): number {
    const handle = fd < MAX_HANDLES ? this.handles[fd] : null;
    if (!handle || !handle.writable) return -1;
    const limit = BigInt(MAX_RAM_FILE);
    if (offset > limit || BigInt(data.length) > limit - offset) return -1;
    const entry = this.entries[handle.entry];
    const at = Number(offset);
    if (data.length !== 0 && at + data.length > entry.size) {
      grow(entry, at + data.length);
      entry.data.fill(0, entry.size, at + data.length);
      entry.size = at + data.length;
    }
    if (data.length !== 0) entry.data.set(data, at);
    entry.dirty = true;
    return data.length;
  }

  close(fd: number): void {
    const handle = fd < MAX_HANDLES ? this.handles[fd] : null;
    if (!handle) return;
    this.handles[fd] = null;
    const entry = this.entries[handle.entry];
    entry.openCount--;
    if (handle.writable) this.flush(handle.entry);
    if (entry.removed && entry.openCount === 0) this.release(handle.entry);
  }

  listDirectory(path: Uint8Array): Listing[] | null {
    const name = directoryName(path);
    if (name === null) return null;
    if (name !== "") {
      const index = this.find(name);
      if (index < 0 || !this.entries[index].directory) return null;
    }
    const skip = name === "" ? 0 : name.length + 1;
    return this.children(name).map((index) => {
      const entry = this.entries[index];
      return {
        name: entry.name.slice(skip),
        size: entry.directory ? 0 : entry.size,
        directory: entry.directory,
      };
    });
  }

  remove(path: Uint8Array): number {
    const name = fileName(path);
    if (name === null) return -1;
    const index = this.find(name);
    if (index < 0) return -1;
    const entry = this.entries[index];
    if (entry.readonly || (entry.directory && this.hasChildren(name))) {
      return -1;
    }
    this.mirrorRemove(entry);
    if (entry.openCount > 0) entry.removed = true;
    else this.release(index);
    return 0;
  }

  rename(fromPath: Uint8Array, toPath: Uint8Array): number {
    const from = fileName(fromPath);
    const to = fileName(toPath);
    if (from === null || to === null) return -1;
    const index = this.find(from);
    if (index < 0 || this.entries[index].readonly) return -1;
    if (from === to) return 0;
    const directory = this.entries[index].directory;
    const prefix = `${from}/`;
    if (directory) {
      // The new name may not lie inside the old one, and every entry below
      // must still fit.
      if (to.startsWith(prefix)) return -1;
      for (const entry of this.entries) {
        if (entry.name === "" || !entry.name.startsWith(prefix)) continue;
        const moved = encoder.encode(`${to}${entry.name.slice(from.length)}`);
        if (moved.length >= MAX_NAME) return -1;
      }
    }
    const existing = this.find(to);
    if (existing >= 0) {
      const target = this.entries[existing];
      if (target.directory || target.readonly || directory) return -1;
    }
    if (!this.ensureParents(to)) return -1;
    // Adding parents may have reused a free slot.
    const source = this.find(from);
    const target = this.find(to);
    if (target >= 0) {
      this.mirrorRemove(this.entries[target]);
      if (this.entries[target].openCount > 0) {
        this.entries[target].removed = true;
      } else this.release(target);
    }
    if (this.hasMirror()) {
      try {
        this.mirror.rename(from, to);
      } catch (error) {
        this.failed("renaming", error);
      }
    }
    if (directory) {
      for (const entry of this.entries) {
        if (
          entry.name === "" || entry.removed || !entry.name.startsWith(prefix)
        ) continue;
        entry.name = `${to}${entry.name.slice(from.length)}`;
        entry.nameBytes = encoder.encode(entry.name);
      }
    }
    this.entries[source].name = to;
    this.entries[source].nameBytes = encoder.encode(to);
    return 0;
  }

  createDirectory(path: Uint8Array): number {
    const name = directoryName(path);
    if (name === null) return -1;
    if (name === "") return 0;
    const index = this.find(name);
    if (index >= 0) return this.entries[index].directory ? 0 : -1;
    if (!this.ensureParents(name)) return -1;
    this.addDirectory(name);
    return 0;
  }
}
