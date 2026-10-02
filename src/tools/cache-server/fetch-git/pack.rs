// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Packs indexed and read with gitoxide.
//!
//! A spooled pack ([`SpooledPack`]) is indexed by gix's `index-pack`
//! machinery: one pass inflates every entry to find its extent and CRC32,
//! then the delta tree is resolved in parallel to hash every object. The
//! index goes to an unlinked temporary file next to the spool and both are
//! memory-mapped, so a [`GitPack`] holds no object data on the heap.
//! Objects are then decoded on demand, by any number of threads at once.
//!
//! The pack comes from an untrusted server, and gix trusts its header:
//! a version it does not support trips an assertion, and the object count
//! sizes an allocation up front. Both are checked here first, along with
//! the size of every object and a deadline to stop by.

use std::io::{self, BufWriter, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use gix_pack::data::input::{BytesToEntriesIter, EntryDataMode, Mode};

use crate::GitFetchError;
use crate::spool::SpooledPack;

pub use gix_object::Kind as ObjectKind;

/// Bytes a pack entry occupies at the least: a one-byte header and a
/// minimal zlib stream. Bounds how many objects a pack of a given size can
/// honestly claim.
const MIN_ENTRY_BYTES: usize = 8;

/// Decoded delta bases each reader keeps, so a chain of deltas is not
/// re-resolved from its root for every object built on it.
const READER_CACHE_BYTES: usize = 32 * 1024 * 1024;

/// Hostile-input limits for [`GitPack::index`].
#[derive(Clone, Copy, Debug)]
pub struct PackLimits {
    /// Most objects a pack may hold. Indexing needs about 80 bytes of memory
    /// per object.
    pub max_objects: u32,
    /// Largest object, decompressed, that indexing or reading will produce.
    pub max_object_size: usize,
}

/// The git object id of `data` as an object of `kind`.
pub fn object_id(kind: ObjectKind, data: &[u8]) -> Result<[u8; 20], GitFetchError> {
    let id = gix_object::compute_hash(gix_hash::Kind::Sha1, kind, data)
        .map_err(|e| GitFetchError::InvalidPackfile(format!("hashing object: {e}")))?;
    Ok(id.as_bytes().try_into().expect("SHA-1 ids are 20 bytes"))
}

/// What a decoding thread needs, kept between reads.
struct Reader {
    inflate: gix_zlib::Inflate,
    cache: gix_pack::cache::lru::MemoryCappedHashmap,
}

/// An indexed pack, read by object id.
pub struct GitPack {
    bundle: gix_pack::Bundle,
    pack_size: usize,
    readers: Mutex<Vec<Reader>>,
}

impl std::fmt::Debug for GitPack {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitPack")
            .field("objects", &self.object_count())
            .field("pack_size", &self.pack_size)
            .finish()
    }
}

/// Fails the iteration with a message of ours, kept to report afterwards.
struct Refusal(Option<GitFetchError>);

impl Refusal {
    fn refuse(&mut self, error: GitFetchError) -> gix_pack::data::input::Error {
        let message = error.to_string();
        self.0 = Some(error);
        gix_pack::data::input::Error::Io(io::Error::other(message).into())
    }
}

impl GitPack {
    /// Index `pack`, writing the index under `dir`. Uses up to `threads`
    /// threads (one per core when zero); call it from a blocking context.
    ///
    /// Setting `interrupt` makes indexing stop at the next object.
    pub fn index(
        pack: SpooledPack,
        dir: &Path,
        limits: PackLimits,
        threads: usize,
        interrupt: &AtomicBool,
    ) -> Result<Self, GitFetchError> {
        let data = pack.into_map();
        let pack_size = data.len();
        check_header(&data, limits)?;

        let invalid = |what: &str, e: &dyn std::fmt::Display| {
            GitFetchError::InvalidPackfile(format!("{what}: {e}"))
        };
        let index_file = tempfile::tempfile_in(dir).map_err(|e| {
            GitFetchError::RequestFailed(format!(
                "create pack index file in {}: {e}",
                dir.display()
            ))
        })?;

        let mut refusal = Refusal(None);
        let written = {
            // The spool verified the trailer as the pack arrived.
            let mut entries = BytesToEntriesIter::new_from_header(
                &data[..],
                Mode::AsIs,
                EntryDataMode::Crc32,
                gix_hash::Kind::Sha1,
            )
            .map_err(|e| invalid("reading pack header", &e))?;
            let hint = entries.size_hint();
            let mut checked = SizeHinted {
                inner: std::iter::from_fn(|| {
                    let entry = match entries.next()? {
                        Ok(entry) => entry,
                        Err(e) => return Some(Err(e)),
                    };
                    if interrupt.load(Ordering::Relaxed) {
                        return Some(Err(refusal.refuse(GitFetchError::RequestFailed(
                            "pack indexing interrupted".into(),
                        ))));
                    }
                    if entry.decompressed_size > limits.max_object_size as u64 {
                        return Some(Err(refusal.refuse(GitFetchError::TooLarge {
                            what: "object size",
                            size: entry.decompressed_size.try_into().unwrap_or(usize::MAX),
                            limit: limits.max_object_size,
                        })));
                    }
                    Some(Ok(entry))
                }),
                hint,
            };
            let mut out = BufWriter::new(&index_file);
            let written = gix_pack::index::write_data_iter_to_stream(
                gix_pack::index::Version::V2,
                || Ok((entry_bytes, &data[..])),
                &mut checked,
                Some(threads),
                &mut gix_features::progress::Discard,
                &mut out,
                interrupt,
                gix_hash::Kind::Sha1,
                Some(limits.max_object_size),
                gix_pack::data::Version::V2,
            );
            (written, out.flush())
        };
        if let Some(error) = refusal.0 {
            return Err(error);
        }
        let (written, flushed) = written;
        written.map_err(|e| invalid("indexing pack", &e))?;
        flushed.map_err(|e| GitFetchError::RequestFailed(format!("write pack index: {e}")))?;

        // SAFETY: the file is private to this process (unlinked at creation)
        // and is not written again.
        let index_map = unsafe { memmap2::Mmap::map(&index_file) }
            .map_err(|e| GitFetchError::RequestFailed(format!("map pack index: {e}")))?;
        let index = gix_pack::index::File::from_data(
            index_map,
            PathBuf::from("spooled.idx"),
            gix_hash::Kind::Sha1,
        )
        .map_err(|e| invalid("opening pack index", &e))?;
        let mut pack = gix_pack::data::File::from_data(
            data,
            PathBuf::from("spooled.pack"),
            gix_hash::Kind::Sha1,
        )
        .map_err(|e| invalid("opening pack", &e))?
        .with_alloc_limit_bytes(Some(limits.max_object_size));
        // Caches key decoded objects by pack id, so every pack needs its own.
        static NEXT_ID: AtomicU32 = AtomicU32::new(0);
        pack.id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

        Ok(Self {
            bundle: gix_pack::Bundle { pack, index },
            pack_size,
            readers: Mutex::new(Vec::new()),
        })
    }

    /// How many objects the pack holds.
    pub fn object_count(&self) -> usize {
        self.bundle.index.num_objects() as usize
    }

    /// The size of the pack in bytes.
    pub fn pack_size(&self) -> usize {
        self.pack_size
    }

    /// Decode the object `id`, or `None` if the pack does not hold it.
    ///
    /// CPU-bound (inflation and delta application): call it from a blocking
    /// context. Safe to call from many threads at once.
    pub fn get(&self, id: &[u8; 20]) -> Result<Option<(ObjectKind, Vec<u8>)>, GitFetchError> {
        let oid = gix_hash::oid::try_from_bytes(id).expect("SHA-1 ids are 20 bytes");
        let mut reader = self.take_reader();
        let mut out = Vec::new();
        let found = self
            .bundle
            .find(oid, &mut out, &mut reader.inflate, &mut reader.cache)
            .map(|found| found.map(|(object, _)| (object.kind, object.data.len())));
        self.return_reader(reader);
        match found {
            // The decoded object is the whole of `out`.
            Ok(Some((kind, _))) => Ok(Some((kind, out))),
            Ok(None) => Ok(None),
            Err(e) => Err(GitFetchError::InvalidPackfile(format!(
                "decoding {}: {e}",
                hex::encode(id)
            ))),
        }
    }
}

impl GitPack {
    /// The kind and size of the object `id`, read from its entry header
    /// (and, for a delta, the first bytes of the delta) without decoding
    /// it. `None` if the pack does not hold it.
    pub fn header(&self, id: &[u8; 20]) -> Result<Option<(ObjectKind, u64)>, GitFetchError> {
        let oid = gix_hash::oid::try_from_bytes(id).expect("SHA-1 ids are 20 bytes");
        let Some(entry) = self.entry(oid)? else {
            return Ok(None);
        };
        let mut reader = self.take_reader();
        let outcome = self
            .bundle
            .pack
            .decode_header(entry, &mut reader.inflate, &|base| {
                self.entry(base)
                    .ok()
                    .flatten()
                    .map(gix_pack::data::decode::header::ResolvedBase::InPack)
            });
        self.return_reader(reader);
        let outcome = outcome.map_err(|e| {
            GitFetchError::InvalidPackfile(format!("reading header of {}: {e}", hex::encode(id)))
        })?;
        Ok(Some((outcome.kind, outcome.object_size)))
    }

    fn entry(&self, id: &gix_hash::oid) -> Result<Option<gix_pack::data::Entry>, GitFetchError> {
        let Some(index) = self.bundle.index.lookup(id) else {
            return Ok(None);
        };
        let offset = self.bundle.index.pack_offset_at_index(index);
        self.bundle
            .pack
            .entry(offset)
            .map(Some)
            .map_err(|e| GitFetchError::InvalidPackfile(format!("reading entry of {id}: {e}")))
    }

    fn take_reader(&self) -> Reader {
        self.readers
            .lock()
            .expect("reader pool lock never poisoned")
            .pop()
            .unwrap_or_else(|| Reader {
                inflate: gix_zlib::Inflate::default(),
                cache: gix_pack::cache::lru::MemoryCappedHashmap::new(READER_CACHE_BYTES),
            })
    }

    fn return_reader(&self, reader: Reader) {
        self.readers
            .lock()
            .expect("reader pool lock never poisoned")
            .push(reader);
    }
}

/// Refuse a pack gix would mishandle: anything but a version 2 header, or an
/// object count beyond the limit or beyond what the pack's size could hold
/// (gix allocates for the claimed count before reading a single object).
fn check_header(data: &[u8], limits: PackLimits) -> Result<(), GitFetchError> {
    let invalid = |msg: String| Err(GitFetchError::InvalidPackfile(msg));
    if data.len() < 12 + 20 {
        return invalid(format!("pack of {} bytes is too short", data.len()));
    }
    if &data[..4] != b"PACK" {
        return invalid("missing PACK signature".into());
    }
    let version = u32::from_be_bytes(data[4..8].try_into().expect("4 bytes"));
    if version != 2 {
        return invalid(format!("unsupported pack version {version}"));
    }
    let count = u32::from_be_bytes(data[8..12].try_into().expect("4 bytes"));
    let room = (data.len() - 12 - 20) / MIN_ENTRY_BYTES;
    if count > limits.max_objects {
        return Err(GitFetchError::TooLarge {
            what: "pack object count",
            size: count as usize,
            limit: limits.max_objects as usize,
        });
    }
    if count as usize > room {
        return invalid(format!(
            "pack claims {count} objects but its {} bytes hold at most {room}",
            data.len()
        ));
    }
    Ok(())
}

/// The bytes of the pack entry at `range`, for resolving deltas while
/// indexing.
fn entry_bytes<'r>(range: gix_pack::data::EntryRange, pack: &'r &[u8]) -> Option<&'r [u8]> {
    pack.get(usize::try_from(range.start).ok()?..usize::try_from(range.end).ok()?)
}

/// An iterator passing through `inner` but reporting `hint` as its size, so
/// gix can size its delta tree for the checked object count.
struct SizeHinted<I> {
    inner: I,
    hint: (usize, Option<usize>),
}

impl<I: Iterator> Iterator for SizeHinted<I> {
    type Item = I::Item;

    fn next(&mut self) -> Option<Self::Item> {
        self.inner.next()
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.hint
    }
}

/// A spool directory or, failing that, the system temporary directory.
pub fn spool_dir(dir: Option<&Path>) -> PathBuf {
    dir.map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testpack::PackBuilder;

    const LIMITS: PackLimits = PackLimits {
        max_objects: 1_000,
        max_object_size: 1 << 20,
    };

    async fn index(pack: Vec<u8>, limits: PackLimits) -> Result<GitPack, GitFetchError> {
        let dir = std::env::temp_dir();
        let spooled = SpooledPack::spool(&pack[..], &dir, usize::MAX).await?;
        GitPack::index(spooled, &dir, limits, 2, &AtomicBool::new(false))
    }

    #[tokio::test]
    async fn reads_whole_objects_and_both_kinds_of_delta() {
        let base = b"hello, world, this is the base object".to_vec();
        let ofs = b"hello, world, this is the delta object".to_vec();
        let refd = b"hello, there, this is another delta".to_vec();
        let mut b = PackBuilder::new();
        let base_idx = b.blob(&base);
        b.ofs_delta(base_idx, &base, &ofs);
        b.ref_delta(&base, &refd);
        let pack = index(b.build(), LIMITS).await.unwrap();

        assert_eq!(pack.object_count(), 3);
        for data in [&base, &ofs, &refd] {
            let id = object_id(ObjectKind::Blob, data).unwrap();
            let (kind, got) = pack.get(&id).unwrap().expect("object present");
            assert_eq!(kind, ObjectKind::Blob);
            assert_eq!(&got, data);
        }
        assert!(pack.get(&[0u8; 20]).unwrap().is_none());

        for data in [&base, &ofs, &refd] {
            let id = object_id(ObjectKind::Blob, data).unwrap();
            assert_eq!(
                pack.header(&id).unwrap(),
                Some((ObjectKind::Blob, data.len() as u64))
            );
        }
        assert!(pack.header(&[0u8; 20]).unwrap().is_none());
    }

    #[tokio::test]
    async fn a_delta_on_itself_is_refused() {
        let mut b = PackBuilder::new();
        b.blob(b"base");
        let err = index(b.build_with_self_ofs_delta(), LIMITS)
            .await
            .unwrap_err();
        assert!(matches!(err, GitFetchError::InvalidPackfile(_)), "{err}");
    }

    #[tokio::test]
    async fn a_delta_on_a_missing_base_is_refused() {
        // A thin pack: the base is not in it.
        let mut b = PackBuilder::new();
        b.raw_ref_delta([0x5a; 20], b"absent base", b"absent base, extended");
        let err = index(b.build(), LIMITS).await.unwrap_err();
        assert!(matches!(err, GitFetchError::InvalidPackfile(_)), "{err}");
    }

    #[tokio::test]
    async fn deltas_on_each_other_are_refused() {
        // Two ref deltas, each naming the other as its base: neither ever
        // resolves.
        let (a, b_data) = (b"first object".to_vec(), b"second object".to_vec());
        let a_id = object_id(ObjectKind::Blob, &a).unwrap();
        let b_id = object_id(ObjectKind::Blob, &b_data).unwrap();
        let mut b = PackBuilder::new();
        b.raw_ref_delta(b_id, &b_data, &a);
        b.raw_ref_delta(a_id, &a, &b_data);
        let err = index(b.build(), LIMITS).await.unwrap_err();
        assert!(matches!(err, GitFetchError::InvalidPackfile(_)), "{err}");
    }

    #[tokio::test]
    async fn concurrent_reads_share_the_pack() {
        let mut b = PackBuilder::new();
        let blobs: Vec<Vec<u8>> = (0..64).map(|i| format!("blob {i}").into_bytes()).collect();
        for blob in &blobs {
            b.blob(blob);
        }
        let pack = std::sync::Arc::new(index(b.build(), LIMITS).await.unwrap());
        std::thread::scope(|s| {
            for chunk in blobs.chunks(8) {
                let pack = &pack;
                s.spawn(move || {
                    for blob in chunk {
                        let id = object_id(ObjectKind::Blob, blob).unwrap();
                        assert_eq!(&pack.get(&id).unwrap().unwrap().1, blob);
                    }
                });
            }
        });
    }

    fn header(version: u32, count: u32) -> Vec<u8> {
        let mut pack = b"PACK".to_vec();
        pack.extend_from_slice(&version.to_be_bytes());
        pack.extend_from_slice(&count.to_be_bytes());
        pack.extend_from_slice(&[0u8; 40]);
        pack
    }

    #[test]
    fn headers_gix_would_mishandle_are_refused() {
        // gix asserts on version 3, and sizes an allocation from the count.
        assert!(check_header(&header(3, 1), LIMITS).is_err());
        assert!(matches!(
            check_header(&header(2, u32::MAX), LIMITS),
            Err(GitFetchError::TooLarge { .. })
        ));
        let generous = PackLimits {
            max_objects: u32::MAX,
            ..LIMITS
        };
        assert!(check_header(&header(2, 1_000_000), generous).is_err());
        check_header(&header(2, 2), generous).unwrap();
    }

    #[tokio::test]
    async fn oversized_objects_are_refused_while_indexing() {
        let mut b = PackBuilder::new();
        b.blob(&vec![7u8; 4096]);
        let err = index(
            b.build(),
            PackLimits {
                max_object_size: 1024,
                ..LIMITS
            },
        )
        .await
        .unwrap_err();
        assert!(
            matches!(
                err,
                GitFetchError::TooLarge {
                    size: 4096,
                    limit: 1024,
                    ..
                }
            ),
            "{err}"
        );
    }

    #[tokio::test]
    async fn an_interrupt_stops_indexing() {
        let mut b = PackBuilder::new();
        b.blob(b"one");
        b.blob(b"two");
        let dir = std::env::temp_dir();
        let spooled = SpooledPack::spool(&b.build()[..], &dir, usize::MAX)
            .await
            .unwrap();
        let err = GitPack::index(spooled, &dir, LIMITS, 1, &AtomicBool::new(true)).unwrap_err();
        assert!(err.to_string().contains("interrupted"), "{err}");
    }
}
