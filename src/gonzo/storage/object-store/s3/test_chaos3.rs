// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The store against chaos3, a separate S3-compatible server process.
//!
//! Buck starts chaos3 as a local resource and hands its endpoint and
//! credentials to the test through the environment. Unlike the in-process
//! s3s server in `test_server`, chaos3 enforces real S3 limits (5 MiB
//! multipart parts, 1000-key list pages) and can inject faults at chosen
//! points, including after a write has taken effect.
//!
//! Each scenario below runs against its own server, configured in `BUILD`
//! and selected by the `chaos3_scenario` cfg. Fault budgets belong to a
//! server, so a scenario with faults holds exactly one test. Buck may run
//! the tests of one target against the same server in turn, so every test
//! works under its own key prefix.

// Each scenario compiles only its own tests, leaving some helpers unused;
// the healthy scenario uses them all, so it keeps the lints.
#![cfg_attr(not(chaos3_scenario = "healthy"), allow(dead_code, unused_imports))]

// BUILD declares the scenario names to check-cfg, which rejects any other
// name here; this rejects a declared scenario that has no tests.
#[cfg(not(any(
    chaos3_scenario = "healthy",
    chaos3_scenario = "put_after_commit",
    chaos3_scenario = "complete_after_commit",
    chaos3_scenario = "transient",
    chaos3_scenario = "slatedb_commit_errors",
    chaos3_scenario = "body_truncated",
    chaos3_scenario = "body_truncated_object_changed",
    chaos3_scenario = "slatedb_multipart_commit_error",
    chaos3_scenario = "slatedb_storage_v1",
)))]
compile_error!("this chaos3_scenario has no tests in test_chaos3.rs");

use std::sync::Arc;

use bytes::Bytes;
use object_store::path::Path;
use object_store::{
    ObjectStore, ObjectStoreExt as _, PutMode, PutOptions, PutPayload, UpdateVersion,
};

use crate::{S3Store, S3StoreBuilder};

/// A store for the chaos3 server Buck started for this test target.
fn chaos3_store() -> S3Store {
    let var = |name: &str| {
        std::env::var(name).unwrap_or_else(|_| {
            panic!("{name} is unset: run this through `buck2 test`, which starts chaos3")
        })
    };
    S3StoreBuilder::from_env()
        .with_endpoint(var("CHAOS3_ENDPOINT"))
        .with_bucket(var("CHAOS3_BUCKET"))
        .with_allow_http(true)
        .build()
        .expect("chaos3 store configuration is valid")
}

/// A key prefix no other test, or earlier attempt of this one, has used.
fn prefix(test: &str) -> String {
    format!("{test}-{}", std::process::id())
}

/// Open (or create) the SlateDB database at `path` on this target's server.
async fn open_db(path: &str) -> slatedb::Db {
    let store: Arc<dyn ObjectStore> = Arc::new(chaos3_store());
    slatedb::Db::builder(path, store).build().await.unwrap()
}

fn value_for(i: u32) -> Vec<u8> {
    format!("value-{i}-").into_bytes().repeat(64)
}

/// Write 200 keys to a fresh database at `path`, flushing after every
/// `flush_every` writes, close it, then reopen and read every key back.
async fn write_reopen_verify(path: &str, flush_every: u32) {
    let db = open_db(path).await;
    for i in 0..200u32 {
        db.put(format!("key-{i:03}").as_bytes(), &value_for(i))
            .await
            .map(|_| ())
            .unwrap();
        if i % flush_every == flush_every - 1 {
            db.flush().await.unwrap();
        }
    }
    db.close().await.unwrap();

    let db = open_db(path).await;
    for i in 0..200u32 {
        let got = db.get(format!("key-{i:03}").as_bytes()).await.unwrap();
        assert_eq!(got.as_deref(), Some(value_for(i).as_slice()), "key-{i:03}");
    }
    db.close().await.unwrap();
}

/// Deterministic patterned payload, distinguishable across sizes/offsets.
fn pattern(len: usize) -> Bytes {
    (0..len).map(|i| (i % 251) as u8).collect::<Vec<_>>().into()
}

fn create() -> PutOptions {
    PutOptions {
        mode: PutMode::Create,
        ..Default::default()
    }
}

fn update(e_tag: Option<String>) -> PutOptions {
    PutOptions {
        mode: PutMode::Update(UpdateVersion {
            e_tag,
            version: None,
        }),
        ..Default::default()
    }
}

/// Upload `body` in parts of `part_size` bytes and complete the upload.
async fn put_multipart(
    store: &S3Store,
    location: &Path,
    body: &Bytes,
    part_size: usize,
) -> object_store::PutResult {
    put_multipart_opts(store, location, body, part_size, Default::default()).await
}

async fn put_multipart_opts(
    store: &S3Store,
    location: &Path,
    body: &Bytes,
    part_size: usize,
    options: object_store::PutMultipartOptions,
) -> object_store::PutResult {
    let mut upload = store.put_multipart_opts(location, options).await.unwrap();
    for chunk in body.chunks(part_size) {
        upload
            .put_part(Bytes::copy_from_slice(chunk).into())
            .await
            .unwrap();
    }
    upload.complete().await.unwrap()
}

#[cfg(chaos3_scenario = "healthy")]
mod healthy {
    use futures::{StreamExt as _, TryStreamExt as _};
    use object_store::{GetOptions, GetRange};

    use super::*;

    #[tokio::test]
    async fn round_trip_and_ranges() {
        let store = chaos3_store();
        let location = Path::from(format!("{}/data.bin", prefix("round-trip")));
        let body = pattern(100_003);

        let put = store.put(&location, body.clone().into()).await.unwrap();
        let got = store.get(&location).await.unwrap();
        assert_eq!(got.meta.e_tag, put.e_tag);
        assert_eq!(got.bytes().await.unwrap(), body);

        let range = store.get_range(&location, 4_000..70_000).await.unwrap();
        assert_eq!(range, body.slice(4_000..70_000));
        let suffix = store
            .get_opts(
                &location,
                GetOptions {
                    range: Some(GetRange::Suffix(10)),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(suffix.bytes().await.unwrap(), body.slice(body.len() - 10..));
        assert_eq!(store.head(&location).await.unwrap().size, body.len() as u64);
    }

    #[tokio::test]
    async fn conditional_writes() {
        let store = chaos3_store();
        let location = Path::from(format!("{}/cas", prefix("conditional")));

        let first = store
            .put_opts(&location, Bytes::from_static(b"one").into(), create())
            .await
            .unwrap();
        let err = store
            .put_opts(&location, Bytes::from_static(b"two").into(), create())
            .await
            .unwrap_err();
        assert!(
            matches!(err, object_store::Error::AlreadyExists { .. }),
            "{err}"
        );

        let second = store
            .put_opts(
                &location,
                Bytes::from_static(b"two").into(),
                update(first.e_tag.clone()),
            )
            .await
            .unwrap();
        let err = store
            .put_opts(
                &location,
                Bytes::from_static(b"three").into(),
                update(first.e_tag),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, object_store::Error::Precondition { .. }),
            "{err}"
        );
        let got = store.get(&location).await.unwrap();
        assert_eq!(got.meta.e_tag, second.e_tag);
        assert_eq!(got.bytes().await.unwrap(), Bytes::from_static(b"two"));
    }

    #[tokio::test]
    async fn multipart_with_full_size_parts() {
        // chaos3, like S3, rejects parts under 5 MiB except the last.
        let store = chaos3_store();
        let location = Path::from(format!("{}/big.bin", prefix("multipart")));
        let body = pattern(11 * 1024 * 1024 + 17);
        put_multipart(&store, &location, &body, 5 * 1024 * 1024).await;
        assert_eq!(
            store.get(&location).await.unwrap().bytes().await.unwrap(),
            body
        );

        let small = Path::from(format!("{}/small.bin", prefix("multipart")));
        let mut upload = store.put_multipart(&small).await.unwrap();
        upload.put_part(pattern(1024).into()).await.unwrap();
        upload.put_part(pattern(1024).into()).await.unwrap();
        upload
            .complete()
            .await
            .expect_err("an undersized leading part must be rejected");
    }

    #[tokio::test]
    async fn multipart_keeps_attributes() {
        use object_store::{Attribute, AttributeValue, Attributes, PutMultipartOptions};

        let store = chaos3_store();
        let location = Path::from(format!("{}/tagged.bin", prefix("multipart-attributes")));
        let attributes = Attributes::from_iter([
            (
                Attribute::ContentType,
                AttributeValue::from("application/x-test"),
            ),
            (
                Attribute::Metadata("putid".into()),
                AttributeValue::from("01J0000000000000000000000"),
            ),
        ]);
        let options = PutMultipartOptions {
            attributes: attributes.clone(),
            ..Default::default()
        };
        let body = pattern(5 * 1024 * 1024 + 3);
        put_multipart_opts(&store, &location, &body, 5 * 1024 * 1024, options).await;

        let got = store.get(&location).await.unwrap();
        for (attribute, value) in &attributes {
            assert_eq!(got.attributes.get(attribute), Some(value), "{attribute:?}");
        }
        assert_eq!(got.bytes().await.unwrap(), body);
    }

    #[tokio::test]
    async fn listing_pages_past_a_thousand_keys() {
        let store = Arc::new(chaos3_store());
        let base = prefix("listing");
        futures::stream::iter(0..1_005)
            .map(|i| {
                let store = Arc::clone(&store);
                let location = Path::from(format!("{base}/key-{i:04}"));
                async move { store.put(&location, PutPayload::new()).await }
            })
            .buffer_unordered(32)
            .try_collect::<Vec<_>>()
            .await
            .unwrap();

        let listed: Vec<_> = store
            .list(Some(&Path::from(base.as_str())))
            .try_collect()
            .await
            .unwrap();
        assert_eq!(listed.len(), 1_005);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn slatedb_round_trip() {
        write_reopen_verify(&format!("{}/db", prefix("slatedb")), 200).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn slatedb_manifest_fencing() {
        let path = format!("{}/db", prefix("fencing"));
        let db1 = open_db(&path).await;
        db1.put(b"a", b"1").await.map(|_| ()).unwrap();
        db1.flush().await.unwrap();

        let db2 = open_db(&path).await;
        assert_eq!(db2.get(b"a").await.unwrap().as_deref(), Some(&b"1"[..]));

        let outcome = tokio::time::timeout(std::time::Duration::from_secs(60), async {
            db1.put(b"c", b"3").await.map(|_| ())?;
            db1.flush().await
        })
        .await
        .expect("fenced writer must fail, not hang");
        outcome.unwrap_err();
        db2.close().await.unwrap();
    }
}

/// `s3.put_object.after_commit=2*return(InternalError)`: the first two
/// writes take effect but answer 500, so their retries meet their own
/// objects. Conditional writes must recognize that as success.
#[cfg(chaos3_scenario = "put_after_commit")]
#[tokio::test]
async fn conditional_writes_survive_errors_after_commit() {
    let store = chaos3_store();
    let location = Path::from(format!("{}/manifest", prefix("put-after-commit")));

    // First fault: the create commits, answers 500, and its retry finds
    // the object it just wrote.
    let created = store
        .put_opts(&location, Bytes::from_static(b"v1").into(), create())
        .await
        .expect("a create whose first attempt took effect succeeded");

    // Second fault: likewise for a compare-and-swap update.
    let updated = store
        .put_opts(
            &location,
            Bytes::from_static(b"v2").into(),
            update(created.e_tag.clone()),
        )
        .await
        .expect("an update whose first attempt took effect succeeded");
    let got = store.get(&location).await.unwrap();
    assert_eq!(got.meta.e_tag, updated.e_tag);
    assert_eq!(got.bytes().await.unwrap(), Bytes::from_static(b"v2"));

    // With the faults spent, real conflicts are still conflicts.
    let err = store
        .put_opts(&location, Bytes::from_static(b"v3").into(), create())
        .await
        .unwrap_err();
    assert!(
        matches!(err, object_store::Error::AlreadyExists { .. }),
        "{err}"
    );
    let err = store
        .put_opts(
            &location,
            Bytes::from_static(b"v3").into(),
            update(created.e_tag),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(err, object_store::Error::Precondition { .. }),
        "{err}"
    );
}

/// `s3.complete_multipart_upload.after_commit=1*return(InternalError)`: the
/// completion takes effect but answers 500, and its retry finds the upload
/// consumed. The upload carries a unique ID in its metadata, as SlateDB's
/// put ID does, which the reconciliation finds on the completed object.
#[cfg(chaos3_scenario = "complete_after_commit")]
#[tokio::test]
async fn multipart_completion_survives_an_error_after_commit() {
    use object_store::{Attribute, AttributeValue, Attributes, PutMultipartOptions};

    let store = chaos3_store();
    let location = Path::from(format!("{}/big.bin", prefix("complete-after-commit")));
    let put_id = (
        Attribute::Metadata("putid".into()),
        AttributeValue::from(prefix("upload")),
    );
    let options = PutMultipartOptions {
        attributes: Attributes::from_iter([put_id.clone()]),
        ..Default::default()
    };
    let body = pattern(6 * 1024 * 1024 + 5);
    let result = put_multipart_opts(&store, &location, &body, 5 * 1024 * 1024, options).await;
    let got = store.get(&location).await.unwrap();
    assert_eq!(got.meta.e_tag, result.e_tag);
    assert_eq!(got.attributes.get(&put_id.0), Some(&put_id.1));
    assert_eq!(got.bytes().await.unwrap(), body);
}

/// `s3.put_object.before=2*return(SlowDown)` and the same for GetObject:
/// errors before anything happens are retried and never reconciled.
#[cfg(chaos3_scenario = "transient")]
#[tokio::test]
async fn transient_errors_are_retried() {
    let store = chaos3_store();
    let location = Path::from(format!("{}/object", prefix("transient")));
    store
        .put_opts(&location, Bytes::from_static(b"payload").into(), create())
        .await
        .expect("two throttled attempts leave a third");
    let got = store.get(&location).await.expect("likewise for a read");
    assert_eq!(got.bytes().await.unwrap(), Bytes::from_static(b"payload"));
}

/// Every fourth PutObject, five times over, takes effect and then answers
/// 500. SlateDB writes its WAL and manifest with conditional puts, where
/// such a fault reads as another writer fencing it out unless the write is
/// recognized as its own. SlateDB also checks a put ID it attaches to each
/// object, so this exercises the two layers together end to end.
#[cfg(chaos3_scenario = "slatedb_commit_errors")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slatedb_survives_errors_after_commit() {
    write_reopen_verify(&format!("{}/db", prefix("slatedb-commit-errors")), 50).await;
}

/// SlateDB through a `storage-v1` campaign: entry errors, errors after
/// commit, delays, and GET bodies cut short, chosen by the pinned seed.
///
/// Each round reopens the database, checks everything earlier rounds left,
/// then overwrites, adds, and deletes keys with periodic flushes, so WAL
/// replay, manifest updates, and SST reads all run under faults. The
/// campaign's trace in `CHAOS3_LOG` shows which faults were chosen; a run
/// that drew none would prove nothing, so the test requires both kinds of
/// error to have been chosen.
///
/// The seed is pinned but the order requests reach chaos3 in is not, so
/// which request draws which fault varies from run to run. Errors after
/// commit hit 5% of mutations; flushing every ten writes makes enough
/// mutations (well over a hundred) that a run drawing none is vanishingly
/// rare, where flushing every fifty left it at about one run in five.
#[cfg(chaos3_scenario = "slatedb_storage_v1")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn slatedb_survives_a_storage_v1_campaign() {
    use std::collections::BTreeMap;

    let path = format!("{}/db", prefix("storage-v1"));
    let mut expected: BTreeMap<String, Vec<u8>> = BTreeMap::new();

    for round in 0..4u32 {
        let db = open_db(&path).await;
        for (key, value) in &expected {
            let got = db.get(key.as_bytes()).await.unwrap();
            assert_eq!(
                got.as_deref(),
                Some(value.as_slice()),
                "round {round}: {key}"
            );
        }
        for i in 0..300u32 {
            let key = format!("key-{:04}", (i * 7 + round * 13) % 600);
            if round > 0 && i % 10 == 0 {
                db.delete(key.as_bytes()).await.map(|_| ()).unwrap();
                expected.remove(&key);
            } else {
                let value = format!("value-{round}-{i}-").into_bytes().repeat(32);
                db.put(key.as_bytes(), &value).await.map(|_| ()).unwrap();
                expected.insert(key, value);
            }
            if i % 10 == 9 {
                db.flush().await.unwrap();
            }
        }
        db.close().await.unwrap();
    }

    let db = open_db(&path).await;
    for i in 0..600u32 {
        let key = format!("key-{i:04}");
        let got = db.get(key.as_bytes()).await.unwrap();
        assert_eq!(
            got.as_deref(),
            expected.get(&key).map(Vec::as_slice),
            "{key}"
        );
    }
    db.close().await.unwrap();

    let log = std::fs::read_to_string(std::env::var("CHAOS3_LOG").unwrap()).unwrap();
    let chosen = |boundary: &str, action: &str| {
        log.lines()
            .filter(|line| line.contains("chaos3 chaos trace:") && line.contains("phase=active"))
            .filter(|line| line.contains(boundary) && line.contains(action))
            .count()
    };
    let entry_errors = chosen(".before ", "action=Error(");
    let commit_errors = chosen(".after_commit ", "action=Error(");
    let truncations = chosen("s3.get_object.body ", "action=Truncate(");
    eprintln!(
        "storage-v1: {entry_errors} entry errors, {commit_errors} errors after commit, \
         {truncations} truncated bodies"
    );
    assert!(entry_errors > 0, "the campaign chose no entry errors");
    assert!(
        commit_errors > 0,
        "the campaign chose no errors after commit"
    );
}

/// `s3.get_object.body=1*off->1*return(truncate)`: the first GetObject body
/// ends after its first 4 KiB chunk, short of its Content-Length.
#[cfg(chaos3_scenario = "body_truncated")]
#[tokio::test]
async fn a_truncated_body_resumes_where_it_stopped() {
    let store = chaos3_store();
    let location = Path::from(format!("{}/object", prefix("body-truncated")));
    let body = pattern(64 * 1024);
    store.put(&location, body.clone().into()).await.unwrap();

    // A ranged read, so the resumed request has to offset within the range.
    let got = store.get_range(&location, 1_000..60_000).await.unwrap();
    assert_eq!(got, body.slice(1_000..60_000));
}

/// The same fault, but the object is replaced while its body is being read:
/// the rest of the old version is gone, and splicing in the new one would
/// return bytes that never existed together.
#[cfg(chaos3_scenario = "body_truncated_object_changed")]
#[tokio::test]
async fn a_body_never_resumes_from_a_different_object() {
    use futures::StreamExt as _;

    let store = chaos3_store();
    let location = Path::from(format!("{}/object", prefix("body-changed")));
    store
        .put(&location, pattern(64 * 1024).into())
        .await
        .unwrap();

    let mut stream = store.get(&location).await.unwrap().into_stream();
    let first = stream.next().await.unwrap().unwrap();
    assert!(!first.is_empty());
    store
        // `pattern` bytes never reach 0xFF, so any 0xFF came from here.
        .put(&location, Bytes::from(vec![0xFF; 64 * 1024]).into())
        .await
        .unwrap();
    let mut rest = Vec::new();
    let failed = loop {
        match stream.next().await {
            Some(Ok(chunk)) => rest.extend_from_slice(&chunk),
            Some(Err(_)) => break true,
            None => break false,
        }
    };
    assert!(
        failed,
        "the read must fail rather than finish from the new object"
    );
    assert!(
        !rest.contains(&0xFF),
        "bytes of the new object were spliced in"
    );
}

/// SlateDB's large SSTs go up by multipart upload, which carries its put ID
/// in the object's metadata. The first completion takes effect but answers
/// 500, so the retry finds the upload consumed; the store recognizes the
/// completed object by its size and that put ID, and the flush succeeds.
/// Without that check SlateDB still recovers, but only by failing the flush
/// and uploading the whole SST again.
#[cfg(chaos3_scenario = "slatedb_multipart_commit_error")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slatedb_large_sst_survives_an_error_after_completion() {
    use futures::TryStreamExt as _;
    use slatedb::config::{FlushOptions, FlushType};

    let path = format!("{}/db", prefix("slatedb-multipart"));
    let value_for = |i: u32| format!("value-{i:05}-").into_bytes().repeat(400);

    // About 14 MiB in one memtable, flushed to a single L0 SST: past the
    // 10 MiB that object_store's BufWriter sends as one PUT.
    let db = open_db(&path).await;
    for i in 0..3_000u32 {
        db.put(format!("key-{i:05}").as_bytes(), &value_for(i))
            .await
            .map(|_| ())
            .unwrap();
    }
    db.flush_with_options(FlushOptions {
        flush_type: FlushType::MemTable,
    })
    .await
    .unwrap();
    db.close().await.unwrap();

    let ssts: Vec<_> = chaos3_store()
        .list(Some(&Path::from(format!("{path}/compacted"))))
        .try_collect()
        .await
        .unwrap();
    assert!(
        ssts.iter().any(|sst| sst.size > 10 * 1024 * 1024),
        "no SST was large enough to need a multipart upload: {ssts:?}"
    );

    let db = open_db(&path).await;
    for i in (0..3_000u32).step_by(97) {
        let got = db.get(format!("key-{i:05}").as_bytes()).await.unwrap();
        assert_eq!(got.as_deref(), Some(value_for(i).as_slice()), "key-{i:05}");
    }
    db.close().await.unwrap();
}
