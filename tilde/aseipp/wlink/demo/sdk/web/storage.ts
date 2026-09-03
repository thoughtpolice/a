// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The browser's save directory: what the guest writes, kept in IndexedDB under
 * the application's own name so a reload starts where the last run stopped.
 *
 * The virtual root's operations are synchronous and IndexedDB's are not, so
 * changes are queued in the order the guest made them and applied one at a
 * time; the first failure is remembered and reported once, the way a native
 * runner reports a save directory it could not write.
 */

import { Mirror, Vfs } from "./files.ts";

const STORE = "files";

interface Record {
  path: string;
  directory: boolean;
  data?: Uint8Array;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("the request failed"));
  });
}

export class IndexedDbMirror implements Mirror {
  private readonly db: IDBDatabase;
  /** Changes run in the order the guest made them, never overlapping. */
  private queue: Promise<void> = Promise.resolve();
  error: string | null = null;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  /** Returns null when the browser has no usable IndexedDB, which is not fatal. */
  static open(name: string): Promise<IndexedDbMirror | null> {
    return new Promise((resolve) => {
      let open: IDBOpenDBRequest;
      try {
        open = indexedDB.open(`console:${name}`, 1);
      } catch {
        resolve(null);
        return;
      }
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(STORE)) {
          open.result.createObjectStore(STORE, { keyPath: "path" });
        }
      };
      open.onsuccess = () => resolve(new IndexedDbMirror(open.result));
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
    });
  }

  /** Loads what was kept into `vfs`, below the mounted assets. */
  async load(vfs: Vfs, warn: (message: string) => void): Promise<void> {
    let records: Record[];
    try {
      const transaction = this.db.transaction(STORE, "readonly");
      records = await request(transaction.objectStore(STORE).getAll());
    } catch (error) {
      warn(`saved files: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    // Directories first, so a file never arrives before the directory it needs.
    const order = [...records].sort((a, b) =>
      Number(b.directory) - Number(a.directory) || a.path.length - b.path.length
    );
    for (const entry of order) {
      const refused = vfs.loadEntry(
        entry.path,
        entry.directory,
        entry.data ? new Uint8Array(entry.data) : null,
      );
      if (refused) warn(`${entry.path}: ${refused}`);
    }
  }

  private enqueue(what: string, path: string, body: () => Promise<void>): void {
    this.queue = this.queue.then(body).catch((error) => {
      if (this.error === null) {
        this.error = `${what} ${path}: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
  }

  private transaction(): IDBObjectStore {
    return this.db.transaction(STORE, "readwrite").objectStore(STORE);
  }

  private async put(entry: Record): Promise<void> {
    await request(this.transaction().put(entry));
  }

  private async drop(path: string): Promise<void> {
    await request(this.transaction().delete(path));
  }

  write(name: string, bytes: Uint8Array): void {
    // The guest keeps writing into its own buffer, so the bytes are copied.
    const data = bytes.slice();
    this.enqueue("writing", name, () => this.put({ path: name, directory: false, data }));
  }

  remove(name: string, _directory: boolean): void {
    this.enqueue("removing", name, () => this.drop(name));
  }

  rename(from: string, to: string): void {
    this.enqueue("renaming", from, async () => {
      const store = this.transaction();
      const records: Record[] = await request(store.getAll());
      const prefix = `${from}/`;
      for (const entry of records) {
        if (entry.path !== from && !entry.path.startsWith(prefix)) continue;
        const moved = `${to}${entry.path.slice(from.length)}`;
        await this.put({ ...entry, path: moved });
        await this.drop(entry.path);
      }
    });
  }

  mkdir(name: string): void {
    this.enqueue("creating", name, () => this.put({ path: name, directory: true }));
  }

  /** Waits for every queued change, for a page that is going away. */
  flush(): Promise<void> {
    return this.queue;
  }
}
