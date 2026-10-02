// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Properties of the storage layer, checked over generated inputs. (Buck runs
//! tests in the repository root, so hegel keeps no example database there.)

use super::test_helpers::*;
use super::*;

use hegel::TestCase;
use hegel::generators as gs;

/// `len` bytes from the stream `seed`: cheap to make in any size, and
/// varied enough for content-defined chunking to find cut points.
fn data(seed: u64, len: usize) -> Bytes {
    let mut state = seed | 1;
    let mut out = Vec::with_capacity(len + 8);
    while out.len() < len {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        out.extend_from_slice(&state.to_le_bytes());
    }
    out.truncate(len);
    Bytes::from(out)
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(f)
}

/// However an upload arrives (any message sizes), the streaming writer cuts
/// exactly the chunks a one-shot put of the same bytes does. That is what
/// lets a blob uploaded one way share its chunks with the same bytes
/// arriving another, and it stores a blob that reads back whole.
#[hegel::test(test_cases = 40, database = None)]
fn streamed_writes_cut_the_chunks_a_one_shot_put_does(tc: TestCase) {
    let seed = tc.draw(gs::integers::<u64>());
    let len = tc.draw(gs::integers::<usize>().max_value(9 << 20));
    let pieces = tc.draw(
        gs::vecs(gs::integers::<usize>().min_value(1).max_value(3 << 20))
            .min_size(1)
            .max_size(16),
    );
    let blob = data(seed, len);
    let digest = ContentDigest::new(DigestFn::Sha256, sha256(&blob));

    block_on(async {
        let streamed = open_memory_store().await;
        let mut writer = streamed.cas_blob_writer(DigestFn::Sha256, Compression::Identity);
        let mut at = 0;
        for &piece in pieces.iter().cycle() {
            if at == blob.len() {
                break;
            }
            let end = (at + piece).min(blob.len());
            writer.write(&blob[at..end]).await.unwrap();
            at = end;
        }
        let (got, size) = writer.finalize_verified(&digest).await.unwrap();
        assert_eq!((got, size), (digest, blob.len()));

        let one_shot = open_memory_store().await;
        one_shot
            .cas_put_blob(&digest, blob.clone(), Compression::Identity)
            .await
            .unwrap();

        let chunks = |m: BlobManifest| {
            m.chunks
                .iter()
                .map(|c| (c.hash, c.size))
                .collect::<Vec<_>>()
        };
        let (a, _) = streamed.cas_get_manifest(&digest).await.unwrap().unwrap();
        let (b, _) = one_shot.cas_get_manifest(&digest).await.unwrap().unwrap();
        assert_eq!(chunks(a), chunks(b));
        assert_eq!(streamed.cas_get_blob(&digest).await.unwrap(), Some(blob));
    });
}

/// Decompressing with a limit gives the data back exactly when the limit
/// covers it, and fails otherwise, for every codec.
#[hegel::test(test_cases = 200, database = None)]
fn bounded_decompression_holds_its_bound(tc: TestCase) {
    let seed = tc.draw(gs::integers::<u64>());
    let len = tc.draw(gs::integers::<usize>().max_value(256 * 1024));
    // Runs of a repeated byte make the codecs actually compress.
    let repetitive = tc.draw(gs::booleans());
    let blob = if repetitive {
        Bytes::from(vec![(seed % 251) as u8; len])
    } else {
        data(seed, len)
    };
    let codec = [Compression::Zstd, Compression::Deflate, Compression::Brotli]
        [tc.draw(gs::integers::<usize>().max_value(2))];
    let limit = tc.draw(gs::integers::<usize>().max_value(len * 2 + 1));

    let packed = codec.compress(&blob).unwrap().into_owned();
    match codec.decompress_at_most(&packed, limit) {
        Ok(got) => {
            assert!(
                limit >= len,
                "{codec:?}: {len} bytes came out under a limit of {limit}"
            );
            assert_eq!(&got[..], &blob[..]);
        }
        Err(_) => assert!(
            limit < len,
            "{codec:?}: refused {len} bytes under a limit of {limit}"
        ),
    }
}

/// Git blob records decode to what was encoded, expiry or none.
#[hegel::test(test_cases = 300, database = None)]
fn git_blob_records_round_trip(tc: TestCase) {
    let mut git_id = [0u8; 20];
    for (i, b) in tc
        .draw(gs::binary().min_size(20).max_size(20))
        .into_iter()
        .enumerate()
    {
        git_id[i] = b;
    }
    let mut hash = [0u8; 32];
    for (i, b) in tc
        .draw(gs::binary().min_size(32).max_size(32))
        .into_iter()
        .enumerate()
    {
        hash[i] = b;
    }
    let size = tc.draw(gs::integers::<u64>());
    let expires = tc
        .draw(gs::booleans())
        .then(|| tc.draw(gs::integers::<i64>().max_value(i64::MAX - 1)));
    let function = [DigestFn::Sha256, DigestFn::Blake3, DigestFn::Sha256Tree]
        [tc.draw(gs::integers::<usize>().max_value(2))];
    let record = GitBlobRecord {
        git_id,
        digest: ContentDigest::new(function, hash),
        size,
        blob_expires_at_ms: expires,
    };
    assert_eq!(
        GitBlobRecord::decode(git_id, function, record.value()).unwrap(),
        record
    );
}
