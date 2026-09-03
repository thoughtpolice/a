// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A save directory on disk, as the native runner's `--save-dir` keeps one:
 * every writable entry of the virtual root is a file below it, each change is
 * written as it is made or closed, and what is there at startup is loaded
 * below the mounted assets.
 */

import { fileName, MAX_RAM_FILE, Mirror, Vfs } from "./files.ts";

const TEMP = ".flush.tmp";

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DirectoryMirror implements Mirror {
  private readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  /** Creates the directory and its parents, as the runner does before loading it. */
  static create(root: string): DirectoryMirror {
    Deno.mkdirSync(root, { recursive: true });
    return new DirectoryMirror(root);
  }

  private path(name: string): string {
    return name === "" ? this.root : `${this.root}/${name}`;
  }

  private parents(name: string): void {
    const at = name.lastIndexOf("/");
    if (at > 0) Deno.mkdirSync(this.path(name.slice(0, at)), { recursive: true });
  }

  private failure(name: string, error: unknown): Error {
    return new Error(`${this.path(name)}: ${reason(error)}`);
  }

  write(name: string, bytes: Uint8Array): void {
    // Through a temporary and a rename, so a failure leaves the previous copy.
    const temp = this.path(TEMP);
    try {
      this.parents(name);
      Deno.writeFileSync(temp, bytes);
      Deno.renameSync(temp, this.path(name));
    } catch (error) {
      try {
        Deno.removeSync(temp);
      } catch {
        // The temporary may never have been created.
      }
      throw this.failure(name, error);
    }
  }

  remove(name: string, _directory: boolean): void {
    try {
      Deno.removeSync(this.path(name));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw this.failure(name, error);
    }
  }

  rename(from: string, to: string): void {
    try {
      this.parents(to);
      Deno.renameSync(this.path(from), this.path(to));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw this.failure(from, error);
    }
  }

  mkdir(name: string): void {
    try {
      Deno.mkdirSync(this.path(name), { recursive: true });
    } catch (error) {
      throw this.failure(name, error);
    }
  }

  /**
   * Loads what is already there into `vfs`, below the mounts. What cannot be
   * represented in the virtual root is reported through `warn` and skipped.
   */
  load(vfs: Vfs, warn: (message: string) => void): void {
    this.loadInto(vfs, "", warn);
  }

  private loadInto(vfs: Vfs, prefix: string, warn: (message: string) => void): void {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(this.path(prefix))];
    } catch (error) {
      warn(`${this.path(prefix)}: ${reason(error)}`);
      return;
    }
    for (const entry of entries) {
      if (prefix === "" && entry.name === TEMP) continue;
      const joined = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const name = fileName(new TextEncoder().encode(joined));
      if (name === null) {
        warn(`${this.root}/${joined}: not a usable name, skipped`);
        continue;
      }
      const full = this.path(name);
      let info: Deno.FileInfo;
      try {
        info = Deno.statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory) {
        const refused = vfs.loadEntry(name, true, null);
        if (refused) warn(`${full}: ${refused}`);
        else this.loadInto(vfs, name, warn);
      } else if (info.isFile) {
        if (info.size > MAX_RAM_FILE) {
          warn(`${full}: unreadable or too large, skipped`);
          continue;
        }
        let data: Uint8Array;
        try {
          data = Deno.readFileSync(full);
        } catch {
          warn(`${full}: unreadable or too large, skipped`);
          continue;
        }
        const refused = vfs.loadEntry(name, false, data);
        if (refused) warn(`${full}: ${refused}`);
      }
    }
  }
}
