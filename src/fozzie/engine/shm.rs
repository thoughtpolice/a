// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Creation and decoding of the shared-memory layout in `runtime/protocol.h`.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{Ordering, fence};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt as _;

use memmap2::{MmapMut, MmapOptions};

use super::protocol::{
    CMP_ENTRY_SIZE, CmpKind, FEATURE_ENTRY_SIZE, SHM_HEADER_SIZE, SHM_LAYOUT_VERSION,
};

const SHM_MAGIC: &[u8; 8] = b"FOZZSHM\0";
const ALIGNMENT: u64 = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CmpObservation {
    pub pc: u64,
    pub arg1: u64,
    pub arg2: u64,
    pub sequence: u32,
    pub width: u8,
    pub kind: CmpKind,
}

#[derive(Debug)]
pub struct SharedMemory {
    path: PathBuf,
    // Retaining the file prevents accidental lifetime coupling between callers
    // and the mapping, and documents who owns the backing object.
    _file: File,
    mapping: MmapMut,
    input_offset: usize,
    input_capacity: usize,
    feature_offset: usize,
    feature_capacity: u32,
    cmp_offset: usize,
    cmp_capacity: u32,
}

impl SharedMemory {
    pub fn create(
        path: &Path,
        max_input: usize,
        feature_capacity: u32,
        cmp_capacity: u32,
    ) -> io::Result<Self> {
        let layout = Layout::new(max_input, feature_capacity, cmp_capacity)?;

        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let file = options.open(path)?;
        file.set_len(layout.total_size_u64)?;

        // SAFETY: this function exclusively creates and sizes the backing file,
        // keeps its descriptor alive for the mapping's lifetime, and never
        // changes its length. The target runtime intentionally shares writes to
        // the mapped feature and comparison regions.
        let mut mapping = unsafe { MmapOptions::new().len(layout.total_size).map_mut(&file)? };

        let mut header = [0_u8; SHM_HEADER_SIZE];
        header[0..8].copy_from_slice(SHM_MAGIC);
        put_u32(&mut header[8..12], SHM_LAYOUT_VERSION);
        put_u32(&mut header[12..16], SHM_HEADER_SIZE as u32);
        put_u64(&mut header[16..24], layout.total_size_u64);
        put_u64(&mut header[24..32], layout.input_offset as u64);
        put_u64(&mut header[32..40], max_input as u64);
        put_u64(&mut header[40..48], layout.feature_offset as u64);
        put_u32(&mut header[48..52], feature_capacity);
        put_u32(&mut header[52..56], FEATURE_ENTRY_SIZE as u32);
        put_u64(&mut header[56..64], layout.cmp_offset as u64);
        put_u32(&mut header[64..68], cmp_capacity);
        put_u32(&mut header[68..72], CMP_ENTRY_SIZE as u32);
        // Header flags and all reserved bytes remain zero.
        mapping[..SHM_HEADER_SIZE].copy_from_slice(&header);

        Ok(Self {
            path: path.to_owned(),
            _file: file,
            mapping,
            input_offset: layout.input_offset,
            input_capacity: max_input,
            feature_offset: layout.feature_offset,
            feature_capacity,
            cmp_offset: layout.cmp_offset,
            cmp_capacity,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn input_capacity(&self) -> usize {
        self.input_capacity
    }

    pub fn feature_capacity(&self) -> u32 {
        self.feature_capacity
    }

    pub fn cmp_capacity(&self) -> u32 {
        self.cmp_capacity
    }

    pub fn total_size(&self) -> usize {
        self.mapping.len()
    }

    pub fn write_input(&mut self, input: &[u8]) -> io::Result<()> {
        if input.len() > self.input_capacity {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "input has {} bytes; shared-memory capacity is {}",
                    input.len(),
                    self.input_capacity
                ),
            ));
        }
        let end = self.input_offset + input.len();
        self.mapping[self.input_offset..end].copy_from_slice(input);
        Ok(())
    }

    pub fn read_features(&self, count: u32) -> io::Result<Vec<u64>> {
        let count = checked_count("feature", count, self.feature_capacity)?;
        // The target publishes its observations before sending Done. Pair the
        // runtime's release fence with an acquire before reading the mapping.
        fence(Ordering::Acquire);

        let mut features = Vec::with_capacity(count);
        for index in 0..count {
            let offset = self.feature_offset + index * FEATURE_ENTRY_SIZE;
            features.push(get_u64(&self.mapping[offset..offset + FEATURE_ENTRY_SIZE]));
        }
        Ok(features)
    }

    pub fn features(&self, count: u32) -> io::Result<Vec<u64>> {
        self.read_features(count)
    }

    pub fn read_cmp(&self, count: u32) -> io::Result<Vec<CmpObservation>> {
        let count = checked_count("comparison", count, self.cmp_capacity)?;
        fence(Ordering::Acquire);

        let mut observations = Vec::with_capacity(count);
        for index in 0..count {
            let offset = self.cmp_offset + index * CMP_ENTRY_SIZE;
            let entry = &self.mapping[offset..offset + CMP_ENTRY_SIZE];
            if entry[30] != 0 || entry[31] != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("comparison {index} has nonzero reserved bytes"),
                ));
            }
            let width = entry[28];
            if !(1..=8).contains(&width) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("comparison {index} has invalid width {width}"),
                ));
            }
            observations.push(CmpObservation {
                pc: get_u64(&entry[0..8]),
                arg1: get_u64(&entry[8..16]),
                arg2: get_u64(&entry[16..24]),
                sequence: get_u32(&entry[24..28]),
                width,
                kind: CmpKind::from_raw(entry[29])?,
            });
        }
        Ok(observations)
    }

    pub fn comparisons(&self, count: u32) -> io::Result<Vec<CmpObservation>> {
        self.read_cmp(count)
    }
}

#[derive(Clone, Copy, Debug)]
struct Layout {
    total_size: usize,
    total_size_u64: u64,
    input_offset: usize,
    feature_offset: usize,
    cmp_offset: usize,
}

impl Layout {
    fn new(max_input: usize, feature_capacity: u32, cmp_capacity: u32) -> io::Result<Self> {
        if max_input == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "shared-memory input capacity must be nonzero",
            ));
        }

        let input_capacity = u64::try_from(max_input).map_err(|_| layout_too_large())?;
        let input_offset = SHM_HEADER_SIZE as u64;
        let input_end = input_offset
            .checked_add(input_capacity)
            .ok_or_else(layout_too_large)?;
        let feature_offset = align_up(input_end).ok_or_else(layout_too_large)?;
        let feature_size = u64::from(feature_capacity)
            .checked_mul(FEATURE_ENTRY_SIZE as u64)
            .ok_or_else(layout_too_large)?;
        let feature_end = feature_offset
            .checked_add(feature_size)
            .ok_or_else(layout_too_large)?;
        let cmp_offset = align_up(feature_end).ok_or_else(layout_too_large)?;
        let cmp_size = u64::from(cmp_capacity)
            .checked_mul(CMP_ENTRY_SIZE as u64)
            .ok_or_else(layout_too_large)?;
        let total_size_u64 = cmp_offset
            .checked_add(cmp_size)
            .ok_or_else(layout_too_large)?;

        Ok(Self {
            total_size: usize::try_from(total_size_u64).map_err(|_| layout_too_large())?,
            total_size_u64,
            input_offset: usize::try_from(input_offset).map_err(|_| layout_too_large())?,
            feature_offset: usize::try_from(feature_offset).map_err(|_| layout_too_large())?,
            cmp_offset: usize::try_from(cmp_offset).map_err(|_| layout_too_large())?,
        })
    }
}

fn align_up(value: u64) -> Option<u64> {
    value
        .checked_add(ALIGNMENT - 1)
        .map(|rounded| rounded & !(ALIGNMENT - 1))
}

fn checked_count(name: &str, count: u32, capacity: u32) -> io::Result<usize> {
    if count > capacity {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("target reported {count} {name}s; capacity is {capacity}"),
        ));
    }
    usize::try_from(count).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{name} count does not fit this platform"),
        )
    })
}

fn layout_too_large() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "requested shared-memory layout is too large",
    )
}

fn get_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().expect("four-byte field"))
}

fn get_u64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes.try_into().expect("eight-byte field"))
}

fn put_u32(bytes: &mut [u8], value: u32) {
    bytes.copy_from_slice(&value.to_le_bytes());
}

fn put_u64(bytes: &mut [u8], value: u64) {
    bytes.copy_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{CMP_CONST, CMP_SWITCH};
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_PATH: AtomicU64 = AtomicU64::new(0);

    struct RemoveFile(PathBuf);

    impl Drop for RemoveFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    fn test_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "fozzie-shm-{}-{}",
            std::process::id(),
            NEXT_PATH.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn new_mapping() -> (RemoveFile, SharedMemory) {
        let path = test_path();
        let cleanup = RemoveFile(path.clone());
        let shared = SharedMemory::create(&path, 64, 16, 4).unwrap();
        (cleanup, shared)
    }

    #[test]
    fn creates_the_c_runtime_layout() {
        let (_cleanup, shared) = new_mapping();
        let header = &shared.mapping[..SHM_HEADER_SIZE];
        assert_eq!(&header[0..8], SHM_MAGIC);
        assert_eq!(get_u32(&header[8..12]), SHM_LAYOUT_VERSION);
        assert_eq!(get_u32(&header[12..16]), SHM_HEADER_SIZE as u32);
        assert_eq!(get_u64(&header[16..24]), 448);
        assert_eq!(get_u64(&header[24..32]), 128);
        assert_eq!(get_u64(&header[32..40]), 64);
        assert_eq!(get_u64(&header[40..48]), 192);
        assert_eq!(get_u32(&header[48..52]), 16);
        assert_eq!(get_u32(&header[52..56]), FEATURE_ENTRY_SIZE as u32);
        assert_eq!(get_u64(&header[56..64]), 320);
        assert_eq!(get_u32(&header[64..68]), 4);
        assert_eq!(get_u32(&header[68..72]), CMP_ENTRY_SIZE as u32);
        assert!(header[72..].iter().all(|byte| *byte == 0));
        assert_eq!(shared.total_size(), 448);
        assert_eq!(shared.input_capacity(), 64);
        assert_eq!(shared.feature_capacity(), 16);
        assert_eq!(shared.cmp_capacity(), 4);
    }

    #[test]
    fn aligns_regions_after_an_unaligned_input() {
        let path = test_path();
        let _cleanup = RemoveFile(path.clone());
        let shared = SharedMemory::create(&path, 3, 1, 1).unwrap();
        let header = &shared.mapping[..SHM_HEADER_SIZE];
        assert_eq!(get_u64(&header[40..48]), 136);
        assert_eq!(get_u64(&header[56..64]), 144);
        assert_eq!(get_u64(&header[16..24]), 176);
    }

    #[test]
    fn writes_input_and_rejects_oversized_input() {
        let (_cleanup, mut shared) = new_mapping();
        shared.write_input(&[1, 2, 3, 4]).unwrap();
        assert_eq!(
            &shared.mapping[shared.input_offset..shared.input_offset + 4],
            &[1, 2, 3, 4]
        );

        let error = shared.write_input(&[0; 65]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn decodes_features_and_comparisons() {
        let (_cleanup, mut shared) = new_mapping();
        let feature_offset = shared.feature_offset;
        put_u64(
            &mut shared.mapping[feature_offset..feature_offset + 8],
            0x1020,
        );
        put_u64(
            &mut shared.mapping[feature_offset + 8..feature_offset + 16],
            0xaabb_ccdd,
        );
        assert_eq!(shared.read_features(2).unwrap(), vec![0x1020, 0xaabb_ccdd]);
        assert_eq!(shared.features(1).unwrap(), vec![0x1020]);

        let first = shared.cmp_offset;
        put_u64(&mut shared.mapping[first..first + 8], 0x1111);
        put_u64(&mut shared.mapping[first + 8..first + 16], 0x2222);
        put_u64(&mut shared.mapping[first + 16..first + 24], 0x3333);
        put_u32(&mut shared.mapping[first + 24..first + 28], 4);
        shared.mapping[first + 28] = 8;
        shared.mapping[first + 29] = CMP_CONST;

        let second = first + CMP_ENTRY_SIZE;
        put_u64(&mut shared.mapping[second..second + 8], 0x4444);
        put_u64(&mut shared.mapping[second + 8..second + 16], 0x5555);
        put_u64(&mut shared.mapping[second + 16..second + 24], 0x6666);
        put_u32(&mut shared.mapping[second + 24..second + 28], 5);
        shared.mapping[second + 28] = 2;
        shared.mapping[second + 29] = CMP_SWITCH;

        assert_eq!(
            shared.read_cmp(2).unwrap(),
            vec![
                CmpObservation {
                    pc: 0x1111,
                    arg1: 0x2222,
                    arg2: 0x3333,
                    sequence: 4,
                    width: 8,
                    kind: CmpKind::Const,
                },
                CmpObservation {
                    pc: 0x4444,
                    arg1: 0x5555,
                    arg2: 0x6666,
                    sequence: 5,
                    width: 2,
                    kind: CmpKind::Switch,
                },
            ]
        );
        assert_eq!(shared.comparisons(1).unwrap()[0].kind, CmpKind::Const);
    }

    #[test]
    fn rejects_counts_and_malformed_comparisons() {
        let (_cleanup, mut shared) = new_mapping();
        assert_eq!(
            shared.read_features(17).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            shared.read_cmp(5).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );

        let offset = shared.cmp_offset;
        shared.mapping[offset + 28] = 0;
        assert_eq!(
            shared.read_cmp(1).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        shared.mapping[offset + 28] = 1;
        shared.mapping[offset + 29] = 0xff;
        assert_eq!(
            shared.read_cmp(1).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        shared.mapping[offset + 29] = CMP_CONST;
        shared.mapping[offset + 31] = 1;
        assert_eq!(
            shared.read_cmp(1).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn rejects_zero_input_capacity_and_existing_path() {
        let path = test_path();
        let _cleanup = RemoveFile(path.clone());
        let error = SharedMemory::create(&path, 0, 1, 1).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);

        let _shared = SharedMemory::create(&path, 1, 1, 1).unwrap();
        let error = SharedMemory::create(&path, 1, 1, 1).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    }
}
