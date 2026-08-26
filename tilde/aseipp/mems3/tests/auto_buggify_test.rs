// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Automatic chaos through the S3 adapter, including a retrying storage client.

use std::task::Poll;

use futures::{StreamExt, stream::FuturesUnordered};

use crate::chaos::{Chaos, ChaosConfig, Phase};

use super::*;

fn chaos_fixture(seed: u64, config: ChaosConfig) -> (Chaos, S3Service) {
    let chaos = Chaos::new(seed, config).unwrap();
    let store = MemoryS3::with_buckets(["celld"]).with_chaos(chaos.clone());
    (chaos, s3_service(store))
}

fn counts(chaos: &Chaos) -> (u64, u64, u64, u64, u64) {
    let snapshot = chaos.snapshot();
    (
        snapshot.visits,
        snapshot.errors_before,
        snapshot.errors_after_commit,
        snapshot.delays,
        snapshot.yields,
    )
}

#[tokio::test(start_paused = true)]
async fn warmup_and_recovery_count_requests_including_failed_ones() {
    let (chaos, service) = chaos_fixture(
        42,
        ChaosConfig {
            warmup_requests: 4,
            requests: Some(8),
            ..ChaosConfig::default()
        },
    );
    assert_eq!(chaos.snapshot().phase, Phase::Warmup);
    for index in 1..=4 {
        assert_eq!(
            status(&service, Method::GET, "/celld/missing").await,
            StatusCode::NOT_FOUND
        );
        assert_eq!(chaos.snapshot().requests, index);
        assert_eq!(counts(&chaos), (0, 0, 0, 0, 0));
    }
    assert_eq!(chaos.snapshot().phase, Phase::Active);
    for index in 5..=12 {
        let response = status(&service, Method::GET, "/celld/missing").await;
        assert!(matches!(
            response,
            StatusCode::NOT_FOUND | StatusCode::SERVICE_UNAVAILABLE
        ));
        assert_eq!(chaos.snapshot().requests, index);
        assert_eq!(chaos.snapshot().visits, index - 4);
    }
    assert_eq!(chaos.snapshot().phase, Phase::Recovery);
    let recovered = counts(&chaos);
    put(&service, "/celld/recovered", "healthy write").await;
    assert_eq!(
        get_text(&service, "/celld/recovered").await,
        "healthy write"
    );
    assert_eq!(chaos.snapshot().requests, 14);
    assert_eq!(
        counts(&chaos),
        recovered,
        "recovery admits requests without selecting faults"
    );
}

#[tokio::test(start_paused = true)]
async fn warmup_does_not_consume_the_seeded_fault_sequence() {
    let (warmed, warmed_service) = chaos_fixture(
        17,
        ChaosConfig {
            warmup_requests: 4,
            ..ChaosConfig::default()
        },
    );
    let (immediate, immediate_service) = chaos_fixture(17, ChaosConfig::default());
    for _ in 0..4 {
        assert_eq!(
            status(&warmed_service, Method::GET, "/celld/missing").await,
            StatusCode::NOT_FOUND
        );
    }
    for _ in 0..64 {
        let started = tokio::time::Instant::now();
        let warmed_status = status(&warmed_service, Method::GET, "/celld/missing").await;
        let warmed_delay = started.elapsed();
        let started = tokio::time::Instant::now();
        let immediate_status = status(&immediate_service, Method::GET, "/celld/missing").await;
        assert_eq!(warmed_status, immediate_status);
        assert_eq!(warmed_delay, started.elapsed());
        assert_eq!(counts(&warmed), counts(&immediate));
    }
    assert!(warmed.snapshot().errors_before > 0);
    assert!(warmed.snapshot().delays > 0);
}

#[tokio::test(start_paused = true)]
async fn admitted_write_keeps_its_active_phase_when_later_requests_enter_recovery() {
    // Select a seed with an asynchronous delay before the first mutation. This
    // checks the lifecycle invariant without baking a PRNG sequence into tests.
    for seed in 0..512 {
        let (chaos, service) = chaos_fixture(
            seed,
            ChaosConfig {
                requests: Some(1),
                ..ChaosConfig::default()
            },
        );
        let mut write = Box::pin(call(
            &service,
            request(Method::PUT, "/celld/in-flight", "committed"),
        ));
        if futures::poll!(&mut write).is_ready() || chaos.snapshot().delays == 0 {
            continue;
        }
        assert_eq!(chaos.snapshot().visits, 1);
        assert_eq!(chaos.snapshot().phase, Phase::Recovery);
        assert_eq!(chaos.snapshot().in_flight, 1);
        assert_eq!(
            status(&service, Method::GET, "/celld/in-flight").await,
            StatusCode::NOT_FOUND
        );
        assert_eq!(chaos.snapshot().requests, 2);
        assert_eq!(chaos.snapshot().visits, 1);

        let response = write.await;
        assert!(matches!(
            response.status(),
            StatusCode::OK | StatusCode::INTERNAL_SERVER_ERROR
        ));
        assert_eq!(
            chaos.snapshot().visits,
            2,
            "the original write still evaluates its postcommit boundary"
        );
        assert_eq!(chaos.snapshot().in_flight, 0);
        assert_eq!(get_text(&service, "/celld/in-flight").await, "committed");
        return;
    }
    panic!("no seed selected a delay before the first PUT");
}

#[tokio::test(start_paused = true)]
async fn canceled_postcommit_delay_keeps_data_visible_and_releases_no_storage_lock() {
    for seed in 0..512 {
        let chaos = Chaos::new(seed, ChaosConfig::default()).unwrap();
        let store = MemoryS3::with_buckets(["celld"]);
        let observer = s3_service(store.clone());
        let service = s3_service(store.with_chaos(chaos.clone()));
        let mut write = Box::pin(call(
            &service,
            request(Method::PUT, "/celld/canceled", "committed"),
        ));
        // A yield can precede the delayed response; polling it again does not
        // advance virtual time or let a delay before the write complete.
        let mut pending = false;
        for _ in 0..3 {
            pending = futures::poll!(&mut write).is_pending();
            if !pending || chaos.snapshot().visits == 2 {
                break;
            }
        }
        if !pending || chaos.snapshot().visits != 2 || chaos.snapshot().delays == 0 {
            continue;
        }

        let mut read = Box::pin(get_text(&observer, "/celld/canceled"));
        assert_eq!(
            futures::poll!(&mut read),
            Poll::Ready("committed".to_owned()),
            "the delayed response must hold no storage lock"
        );
        drop(read);
        let selected = counts(&chaos);
        assert_eq!(chaos.snapshot().in_flight, 1);
        drop(write);
        assert_eq!(chaos.snapshot().in_flight, 0);
        assert_eq!(
            counts(&chaos),
            selected,
            "canceling a response consumes its selected decision"
        );
        put(&observer, "/celld/canceled", "replacement").await;
        assert_eq!(get_text(&observer, "/celld/canceled").await, "replacement");
        return;
    }
    panic!("no seed selected a delay after committing the first PUT");
}

#[tokio::test(start_paused = true)]
async fn concurrent_clones_share_a_campaign_and_independent_instances_replay_it() {
    let (parallel, service) = chaos_fixture(42, ChaosConfig::default());
    let (sequential, replay) = chaos_fixture(42, ChaosConfig::default());
    let sibling = service.clone();
    let healthy = fixture();
    let mut requests = FuturesUnordered::new();
    let mut actual = vec![None; 128];
    let mut completion_order = Vec::new();
    for index in 0..128 {
        let service = if index % 2 == 0 { &service } else { &sibling };
        let mut write = Box::pin(call(
            service,
            request(Method::PUT, &format!("/celld/{index:04}"), "contents"),
        ));
        // Explicit first polls establish identical admission order in both runs.
        // Delayed/yielding writes complete after later admissions and commits.
        match futures::poll!(&mut write) {
            Poll::Ready(response) => {
                actual[index] = Some(response.status());
                completion_order.push(index);
            }
            Poll::Pending => requests.push(async move { (index, write.await.status()) }),
        }
    }
    while let Some((index, status)) = requests.next().await {
        actual[index] = Some(status);
        completion_order.push(index);
    }
    let mut expected = Vec::new();
    for index in 0..128 {
        expected.push(Some(
            call(
                &replay,
                request(Method::PUT, &format!("/celld/{index:04}"), "contents"),
            )
            .await
            .status(),
        ));
    }
    assert_ne!(completion_order, (0..128).collect::<Vec<_>>());
    assert_eq!(
        actual, expected,
        "postcommit choices must not depend on completion order"
    );
    assert_eq!(parallel.snapshot().requests, 128);
    assert_eq!(parallel.snapshot().in_flight, 0);
    assert!(parallel.snapshot().errors_before > 0);
    assert!(parallel.snapshot().errors_after_commit > 0);
    assert_eq!(counts(&parallel), counts(&sequential));
    assert_eq!(
        status(&healthy, Method::GET, "/celld/missing").await,
        StatusCode::NOT_FOUND
    );
}

async fn retrying_get(service: &S3Service, key: &str) -> String {
    for _ in 0..32 {
        let response = call(service, request(Method::GET, key, Body::empty())).await;
        match response.status() {
            StatusCode::OK => return body_text(response).await,
            StatusCode::SERVICE_UNAVAILABLE => {
                expect_error(response, StatusCode::SERVICE_UNAVAILABLE, "SlowDown").await
            }
            unexpected => panic!(
                "GET {key} returned {unexpected}: {}",
                body_text(response).await
            ),
        }
    }
    panic!("GET {key} exhausted its retry budget");
}

#[tokio::test(start_paused = true)]
async fn immutable_object_client_reconciles_ambiguous_commits_then_audits_recovery() {
    let (chaos, service) = chaos_fixture(
        42,
        ChaosConfig {
            requests: Some(512),
            ..ChaosConfig::default()
        },
    );
    let mut reconciled = 0;
    let mut expected = Vec::new();
    for index in 0..128 {
        let key = format!("/celld/immutable/{index:04}");
        let value = format!("immutable contents for object {index}");
        let mut committed = false;
        for _ in 0..32 {
            let response = call(
                &service,
                with_headers(Method::PUT, &key, value.clone(), &[("if-none-match", "*")]),
            )
            .await;
            match response.status() {
                StatusCode::OK => committed = true,
                StatusCode::PRECONDITION_FAILED => {
                    // A lost response can leave the conditional write committed.
                    // Reconcile with storage instead of treating 412 as success.
                    expect_error(
                        response,
                        StatusCode::PRECONDITION_FAILED,
                        "PreconditionFailed",
                    )
                    .await;
                    assert_eq!(retrying_get(&service, &key).await, value);
                    reconciled += 1;
                    committed = true;
                }
                StatusCode::INTERNAL_SERVER_ERROR => {
                    expect_error(response, StatusCode::INTERNAL_SERVER_ERROR, "InternalError").await
                }
                StatusCode::SERVICE_UNAVAILABLE => {
                    expect_error(response, StatusCode::SERVICE_UNAVAILABLE, "SlowDown").await
                }
                unexpected => panic!(
                    "PUT {key} returned {unexpected}: {}",
                    body_text(response).await
                ),
            }
            if committed {
                break;
            }
        }
        assert!(committed, "PUT {key} exhausted its retry budget");
        assert_eq!(retrying_get(&service, &key).await, value);
        expected.push((key, value));
    }
    assert!(chaos.snapshot().errors_before > 0);
    assert!(chaos.snapshot().errors_after_commit > 0);
    assert_eq!(reconciled, chaos.snapshot().errors_after_commit);

    while chaos.snapshot().phase == Phase::Active {
        let _ = status(&service, Method::GET, "/celld/missing").await;
    }
    assert_eq!(chaos.snapshot().requests, 512);
    let recovered = counts(&chaos);
    let listing = call(
        &service,
        request(Method::GET, "/celld?list-type=2", Body::empty()),
    )
    .await;
    assert_eq!(listing.status(), StatusCode::OK);
    let keys = xml_values(&body_text(listing).await, "Key");
    assert_eq!(
        keys,
        expected
            .iter()
            .map(|(key, _)| key.trim_start_matches("/celld/").to_owned())
            .collect::<Vec<_>>()
    );
    for (key, value) in expected {
        assert_eq!(get_text(&service, &key).await, value);
        assert_eq!(
            status(&service, Method::DELETE, &key).await,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            status(&service, Method::GET, &key).await,
            StatusCode::NOT_FOUND
        );
    }
    let listing = call(
        &service,
        request(Method::GET, "/celld?list-type=2", Body::empty()),
    )
    .await;
    assert_eq!(listing.status(), StatusCode::OK);
    assert!(xml_values(&body_text(listing).await, "Key").is_empty());
    assert_eq!(counts(&chaos), recovered);
}
