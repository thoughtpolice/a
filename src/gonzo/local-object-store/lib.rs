// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! An [`ObjectStore`] over a local directory whose reads run on a dedicated
//! pool of I/O threads.
//!
//! `object_store`'s [`LocalFileSystem`] reads through Tokio's blocking pool,
//! twice per read: once to open the file and read its metadata, and again
//! to read the bytes (`GetResult::bytes`). Each trip takes the blocking
//! pool's one shared mutex, and a store doing tens of thousands of small
//! reads a second (SlateDB reading SST blocks) keeps every async worker
//! queueing on it: a dial9 trace of a busy cache server found that mutex
//! the largest thing its workers waited on.
//!
//! [`PooledLocalFileSystem`] answers reads in one trip to its own threads,
//! which take jobs from a lock-free queue, and hands the bytes back already
//! read. Everything else (writes, listings, copies, renames) goes to the
//! wrapped [`LocalFileSystem`] unchanged, so its semantics (atomic writes,
//! conditional puts, path encoding) are its own.

use std::fs::File;
use std::ops::Range;
use std::os::unix::fs::FileExt as _;
use std::path::PathBuf;

use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt as _;
use futures::stream::BoxStream;
use object_store::local::LocalFileSystem;
use object_store::path::Path;
use object_store::{
    CopyOptions, GetOptions, GetResult, GetResultPayload, ListResult, MultipartUpload, ObjectMeta,
    ObjectStore, PutMultipartOptions, PutOptions, PutPayload, PutResult, RenameOptions, Result,
};

/// Reads larger than this keep `LocalFileSystem`'s file payload, which its
/// callers can stream, rather than being read into memory whole.
const MAX_BUFFERED_READ: u64 = 32 * 1024 * 1024;

const STORE: &str = "LocalFileSystem";

/// A local directory as an object store, reading on its own I/O threads.
#[derive(Debug)]
pub struct PooledLocalFileSystem {
    inner: LocalFileSystem,
    io: IoPool,
}

impl PooledLocalFileSystem {
    /// The store rooted at `root` (which must exist), reading on `threads`
    /// threads.
    pub fn new_with_prefix(root: impl AsRef<std::path::Path>, threads: usize) -> Result<Self> {
        Ok(Self {
            inner: LocalFileSystem::new_with_prefix(root)?,
            io: IoPool::new(threads.max(1)),
        })
    }
}

impl std::fmt::Display for PooledLocalFileSystem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Pooled{}", self.inner)
    }
}

#[async_trait]
impl ObjectStore for PooledLocalFileSystem {
    async fn put_opts(
        &self,
        location: &Path,
        payload: PutPayload,
        opts: PutOptions,
    ) -> Result<PutResult> {
        self.inner.put_opts(location, payload, opts).await
    }

    async fn put_multipart_opts(
        &self,
        location: &Path,
        opts: PutMultipartOptions,
    ) -> Result<Box<dyn MultipartUpload>> {
        self.inner.put_multipart_opts(location, opts).await
    }

    async fn get_opts(&self, location: &Path, options: GetOptions) -> Result<GetResult> {
        if options.head {
            return self.inner.get_opts(location, options).await;
        }
        let path = self.inner.path_to_filesystem(location)?;
        let location = location.clone();
        self.io.run(move || get(&path, location, options)).await
    }

    async fn get_ranges(&self, location: &Path, ranges: &[Range<u64>]) -> Result<Vec<Bytes>> {
        let path = self.inner.path_to_filesystem(location)?;
        let ranges = ranges.to_vec();
        self.io
            .run(move || {
                let file = open(&path)?;
                let len = metadata(&file, &path)?.len();
                ranges
                    .into_iter()
                    .map(|range| {
                        let range = object_store::GetRange::Bounded(range)
                            .as_range(len)
                            .map_err(generic)?;
                        read_range(&file, &path, range)
                    })
                    .collect()
            })
            .await
    }

    fn delete_stream(
        &self,
        locations: BoxStream<'static, Result<Path>>,
    ) -> BoxStream<'static, Result<Path>> {
        self.inner.delete_stream(locations)
    }

    fn list(&self, prefix: Option<&Path>) -> BoxStream<'static, Result<ObjectMeta>> {
        self.inner.list(prefix)
    }

    fn list_with_offset(
        &self,
        prefix: Option<&Path>,
        offset: &Path,
    ) -> BoxStream<'static, Result<ObjectMeta>> {
        self.inner.list_with_offset(prefix, offset)
    }

    async fn list_with_delimiter(&self, prefix: Option<&Path>) -> Result<ListResult> {
        self.inner.list_with_delimiter(prefix).await
    }

    async fn copy_opts(&self, from: &Path, to: &Path, options: CopyOptions) -> Result<()> {
        self.inner.copy_opts(from, to, options).await
    }

    async fn rename_opts(&self, from: &Path, to: &Path, options: RenameOptions) -> Result<()> {
        self.inner.rename_opts(from, to, options).await
    }
}

/// `GetOptions` answered as `LocalFileSystem` answers them, with the bytes
/// read here rather than on a second trip.
fn get(path: &std::path::Path, location: Path, options: GetOptions) -> Result<GetResult> {
    let file = open(path)?;
    let metadata = metadata(&file, path)?;
    let meta = ObjectMeta {
        location,
        last_modified: metadata.modified().map_err(generic)?.into(),
        size: metadata.len(),
        e_tag: Some(etag(&metadata)),
        version: None,
    };
    options.check_preconditions(&meta)?;
    let range = match &options.range {
        Some(range) => range.as_range(meta.size).map_err(generic)?,
        None => 0..meta.size,
    };
    let payload = if range.end - range.start > MAX_BUFFERED_READ {
        GetResultPayload::File(file, path.to_path_buf())
    } else {
        let bytes = read_range(&file, path, range.clone())?;
        GetResultPayload::Stream(futures::stream::once(async move { Ok(bytes) }).boxed())
    };
    Ok(GetResult {
        payload,
        attributes: Default::default(),
        range,
        meta,
        extensions: Default::default(),
    })
}

fn open(path: &std::path::Path) -> Result<File> {
    File::open(path).map_err(|e| io_error(e, path))
}

fn metadata(file: &File, path: &std::path::Path) -> Result<std::fs::Metadata> {
    let metadata = file.metadata().map_err(|e| io_error(e, path))?;
    if metadata.is_dir() {
        return Err(object_store::Error::NotFound {
            path: path.to_string_lossy().into_owned(),
            source: "is a directory".into(),
        });
    }
    Ok(metadata)
}

/// Exactly `range` of `file`, or an error if it ends first.
fn read_range(file: &File, path: &std::path::Path, range: Range<u64>) -> Result<Bytes> {
    let mut buf = vec![0u8; (range.end - range.start) as usize];
    file.read_exact_at(&mut buf, range.start)
        .map_err(|e| io_error(e, path))?;
    Ok(Bytes::from(buf))
}

/// `LocalFileSystem`'s ETag: inode, modification time, and size.
fn etag(metadata: &std::fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt as _;
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
        .unwrap_or_default()
        .as_micros();
    format!("\"{:x}-{mtime:x}-{:x}\"", metadata.ino(), metadata.len())
}

fn io_error(e: std::io::Error, path: &std::path::Path) -> object_store::Error {
    match e.kind() {
        std::io::ErrorKind::NotFound => object_store::Error::NotFound {
            path: path.to_string_lossy().into_owned(),
            source: e.into(),
        },
        _ => generic(e),
    }
}

fn generic(e: impl std::error::Error + Send + Sync + 'static) -> object_store::Error {
    object_store::Error::Generic {
        store: STORE,
        source: Box::new(e),
    }
}

// -------------------------------------------------------------------------------------------------

type Job = Box<dyn FnOnce() + Send>;

/// Threads running blocking reads, fed through a lock-free queue. They
/// exit once the pool is dropped.
#[derive(Debug)]
struct IoPool {
    jobs: crossbeam_channel::Sender<Job>,
}

impl IoPool {
    fn new(threads: usize) -> Self {
        let (jobs, queue) = crossbeam_channel::unbounded::<Job>();
        for i in 0..threads {
            let queue = queue.clone();
            std::thread::Builder::new()
                .name(format!("local-io-{i}"))
                .spawn(move || {
                    while let Ok(job) = queue.recv() {
                        // A panicking read fails its caller (its result
                        // sender drops), not the thread.
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
                    }
                })
                .expect("spawn an I/O thread");
        }
        Self { jobs }
    }

    async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let job: Job = Box::new(move || {
            let _ = tx.send(work());
        });
        if self.jobs.send(job).is_err() {
            return Err(generic(std::io::Error::other("the I/O pool has stopped")));
        }
        rx.await
            .unwrap_or_else(|_| Err(generic(std::io::Error::other("an I/O job panicked"))))
    }
}

#[cfg(test)]
mod tests;
