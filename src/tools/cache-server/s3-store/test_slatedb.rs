// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! SlateDB running on top of the S3 backend, end to end.
//!
//! This exercises the store through its real consumer: SlateDB's manifest
//! CAS depends on `PutMode::Create` conditional puts, its WAL/SST handling
//! on ranged gets, multipart-capable writes, and listing, and its garbage
//! collection on deletes. Both cold-start and reopen paths run against the
//! in-memory s3s server with signature verification enabled.

use std::sync::Arc;
use std::time::Duration;

use crate::test_server::TestServer;

fn value_for(i: u32) -> Vec<u8> {
    // values big enough that a flush produces real SST payloads
    format!("value-{i}-").into_bytes().repeat(64)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slatedb_over_s3_roundtrip() {
    let server = TestServer::spawn().await;

    // first open: write and flush
    {
        let store: Arc<dyn slatedb::object_store::ObjectStore> = Arc::new(server.store());
        let db = slatedb::Db::builder("test/db", store)
            .build()
            .await
            .unwrap();
        for i in 0..100u32 {
            db.put(format!("key-{i:03}").as_bytes(), &value_for(i))
                .await
                .map(|_handle| ())
                .unwrap();
        }
        db.flush().await.unwrap();

        for i in (0..100u32).step_by(7) {
            let got = db.get(format!("key-{i:03}").as_bytes()).await.unwrap();
            assert_eq!(got.as_deref(), Some(value_for(i).as_slice()), "key-{i:03}");
        }
        db.close().await.unwrap();
    }

    // reopen from the same bucket: everything must still be there, which
    // proves the manifest, WAL, and SSTs survived the S3 round trip
    {
        let store: Arc<dyn slatedb::object_store::ObjectStore> = Arc::new(server.store());
        let db = slatedb::Db::builder("test/db", store)
            .build()
            .await
            .unwrap();
        for i in 0..100u32 {
            let got = db.get(format!("key-{i:03}").as_bytes()).await.unwrap();
            assert_eq!(got.as_deref(), Some(value_for(i).as_slice()), "key-{i:03}");
        }

        // overwrite and delete still work after reopen
        db.put(b"key-000", b"replaced")
            .await
            .map(|_handle| ())
            .unwrap();
        db.delete(b"key-001").await.map(|_handle| ()).unwrap();
        db.flush().await.unwrap();
        assert_eq!(
            db.get(b"key-000").await.unwrap().as_deref(),
            Some(&b"replaced"[..])
        );
        assert_eq!(db.get(b"key-001").await.unwrap(), None);
        db.close().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slatedb_manifest_fencing() {
    // opening a second writer against the same database relies on
    // conditional-put manifest CAS to fence the first one out
    let server = TestServer::spawn().await;

    let store1: Arc<dyn slatedb::object_store::ObjectStore> = Arc::new(server.store());
    let db1 = slatedb::Db::builder("fence/db", store1)
        .build()
        .await
        .unwrap();
    db1.put(b"a", b"1").await.map(|_handle| ()).unwrap();
    db1.flush().await.unwrap();

    let store2: Arc<dyn slatedb::object_store::ObjectStore> = Arc::new(server.store());
    let db2 = slatedb::Db::builder("fence/db", store2)
        .build()
        .await
        .unwrap();
    assert_eq!(db2.get(b"a").await.unwrap().as_deref(), Some(&b"1"[..]));
    db2.put(b"b", b"2").await.map(|_handle| ()).unwrap();
    db2.flush().await.unwrap();

    // the fenced-out first writer must fail once it tries to write
    let outcome = tokio::time::timeout(Duration::from_secs(60), async {
        db1.put(b"c", b"3").await.map(|_handle| ())?;
        db1.flush().await
    })
    .await
    .expect("fenced writer must fail, not hang");
    outcome.unwrap_err();

    db2.close().await.unwrap();
}
