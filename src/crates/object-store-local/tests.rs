// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The pooled store answers reads exactly as `LocalFileSystem` does over the
//! same directory.

use super::*;

use std::sync::Arc;

use object_store::{GetRange, ObjectStoreExt as _};

struct Pair {
    _dir: tempfile::TempDir,
    pooled: PooledLocalFileSystem,
    plain: LocalFileSystem,
}

fn pair() -> Pair {
    let dir = tempfile::tempdir().expect("temp dir");
    Pair {
        pooled: PooledLocalFileSystem::new_with_prefix(dir.path(), 4).expect("pooled"),
        plain: LocalFileSystem::new_with_prefix(dir.path()).expect("plain"),
        _dir: dir,
    }
}

fn data(len: usize) -> Bytes {
    (0..len)
        .map(|i| (i * 31 % 251) as u8)
        .collect::<Vec<_>>()
        .into()
}

async fn same_get(p: &Pair, location: &Path, options: GetOptions) {
    let pooled = p.pooled.get_opts(location, options.clone()).await;
    let plain = p.plain.get_opts(location, options).await;
    match (pooled, plain) {
        (Ok(a), Ok(b)) => {
            assert_eq!(a.meta, b.meta);
            assert_eq!(a.range, b.range);
            assert_eq!(a.bytes().await.unwrap(), b.bytes().await.unwrap());
        }
        (Err(a), Err(b)) => assert_eq!(
            std::mem::discriminant(&a),
            std::mem::discriminant(&b),
            "{a} vs {b}"
        ),
        (a, b) => panic!(
            "pooled {:?} but plain {:?}",
            a.map(|r| r.meta),
            b.map(|r| r.meta)
        ),
    }
}

#[tokio::test]
async fn reads_match_local_file_system() {
    let p = pair();
    let location = Path::from("sst/0001.sst");
    p.plain.put(&location, data(100_000).into()).await.unwrap();

    same_get(&p, &location, GetOptions::default()).await;
    for range in [
        GetRange::Bounded(0..1),
        GetRange::Bounded(4096..8192),
        GetRange::Bounded(99_000..200_000),
        GetRange::Bounded(100_000..100_001),
        GetRange::Offset(50_000),
        GetRange::Offset(100_000),
        GetRange::Suffix(10),
        GetRange::Suffix(1_000_000),
    ] {
        let options = GetOptions {
            range: Some(range),
            ..Default::default()
        };
        same_get(&p, &location, options).await;
    }

    let ranges = [0..10, 5000..5100, 99_990..100_000];
    assert_eq!(
        p.pooled.get_ranges(&location, &ranges).await.unwrap(),
        p.plain.get_ranges(&location, &ranges).await.unwrap()
    );
    assert_eq!(
        p.pooled.head(&location).await.unwrap(),
        p.plain.head(&location).await.unwrap()
    );
}

#[tokio::test]
async fn missing_objects_are_not_found() {
    let p = pair();
    let missing = Path::from("no/such.sst");
    let err = p.pooled.get(&missing).await.unwrap_err();
    assert!(matches!(err, object_store::Error::NotFound { .. }), "{err}");
    let err = p.pooled.get_ranges(&missing, &[0..1]).await.unwrap_err();
    assert!(matches!(err, object_store::Error::NotFound { .. }), "{err}");
}

#[tokio::test]
async fn preconditions_hold() {
    let p = pair();
    let location = Path::from("manifest/01");
    p.pooled.put(&location, data(10).into()).await.unwrap();
    let e_tag = p.pooled.head(&location).await.unwrap().e_tag.unwrap();

    for options in [
        GetOptions {
            if_match: Some(e_tag.clone()),
            ..Default::default()
        },
        GetOptions {
            if_match: Some("\"other\"".into()),
            ..Default::default()
        },
        GetOptions {
            if_none_match: Some(e_tag.clone()),
            ..Default::default()
        },
    ] {
        same_get(&p, &location, options).await;
    }
}

/// Reads bigger than the buffering limit keep the streamable file payload.
#[tokio::test]
async fn large_reads_stay_files() {
    let p = pair();
    let location = Path::from("big");
    let big = data((MAX_BUFFERED_READ + 1) as usize);
    p.pooled.put(&location, big.clone().into()).await.unwrap();
    let got = p.pooled.get(&location).await.unwrap();
    assert!(matches!(got.payload, GetResultPayload::File(..)));
    assert_eq!(got.bytes().await.unwrap(), big);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_reads() {
    let p = Arc::new(pair());
    let location = Path::from("shared");
    let blob = data(1 << 20);
    p.pooled.put(&location, blob.clone().into()).await.unwrap();
    let reads: Vec<_> = (0..256u64)
        .map(|i| {
            let (p, location, blob) = (p.clone(), location.clone(), blob.clone());
            tokio::spawn(async move {
                let start = (i * 4093) % (blob.len() as u64 - 4096);
                let got = p
                    .pooled
                    .get_range(&location, start..start + 4096)
                    .await
                    .unwrap();
                assert_eq!(got, blob.slice(start as usize..start as usize + 4096));
            })
        })
        .collect();
    for r in reads {
        r.await.unwrap();
    }
}
