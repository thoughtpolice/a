// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! External-consumer checks, including the shape of an asynchronous S3 backend.

use std::collections::HashMap;
use std::ops::ControlFlow;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::time::Duration;

use faultline::{Action, BuggifyConfig, Injector, Point, Probability};

#[derive(Clone, Debug, PartialEq, Eq)]
enum S3Fault {
    InternalError,
    SlowDown,
}

#[derive(Clone)]
struct Store {
    objects: Arc<Mutex<HashMap<String, String>>>,
    before_get: Point<S3Fault>,
    after_put: Point<S3Fault>,
}

impl Store {
    fn new(faults: &Injector<S3Fault>) -> Self {
        Self {
            objects: Arc::default(),
            before_get: faults.point("s3.get.before"),
            after_put: faults.point("s3.put.after"),
        }
    }

    async fn get(&self, key: &str) -> Result<Option<String>, S3Fault> {
        faultline::fail_point_async!(self.before_get, |fault| Err(fault));
        Ok(self.objects.lock().unwrap().get(key).cloned())
    }

    async fn put(&self, key: &str, value: &str) -> Result<(), S3Fault> {
        {
            let mut objects = self.objects.lock().unwrap();
            objects.insert(key.to_owned(), value.to_owned());
        }
        faultline::fail_point_async!(self.after_put, |fault| Err(fault));
        Ok(())
    }
}

#[tokio::test]
async fn independent_services_can_use_the_same_point_names() {
    assert!(faultline::enabled());
    let faults = Injector::new();
    let store = Store::new(&faults);
    let other = Store::new(&Injector::new());
    store.put("manifest", "first").await.unwrap();
    other.put("manifest", "second").await.unwrap();

    faults
        .configure("s3.get.before", Action::Return(S3Fault::SlowDown).times(2))
        .unwrap();

    let first = store.clone();
    let second = store.clone();
    let first = tokio::spawn(async move { first.get("manifest").await });
    let second = tokio::spawn(async move { second.get("manifest").await });
    assert_eq!(other.get("manifest").await, Ok(Some("second".to_owned())));
    assert_eq!(first.await.unwrap(), Err(S3Fault::SlowDown));
    assert_eq!(second.await.unwrap(), Err(S3Fault::SlowDown));
    assert_eq!(store.get("manifest").await, Ok(Some("first".to_owned())));
}

#[tokio::test]
async fn a_post_commit_fault_models_an_ambiguous_write() {
    let faults = Injector::new();
    let store = Store::new(&faults);
    faults
        .configure(
            "s3.put.after",
            Action::Return(S3Fault::InternalError).times(1),
        )
        .unwrap();

    assert_eq!(
        store.put("manifest", "committed").await,
        Err(S3Fault::InternalError)
    );
    assert_eq!(
        store.get("manifest").await,
        Ok(Some("committed".to_owned()))
    );
    assert_eq!(store.put("manifest", "retried").await, Ok(()));
}

#[test]
fn finite_fault_counts_are_shared_across_parallel_threads() {
    const THREADS: usize = 8;
    const HITS: usize = 64;
    const FAILURES: usize = 73;

    let faults = Injector::new();
    let point = faults.point("s3.get.before");
    point
        .set(Action::Return(503).times(FAILURES as u64))
        .unwrap();
    let start = Arc::new(Barrier::new(THREADS));
    let workers: Vec<_> = (0..THREADS)
        .map(|_| {
            let point = point.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                (0..HITS)
                    .filter(|_| point.hit() == ControlFlow::Break(503))
                    .count()
            })
        })
        .collect();

    let failures: usize = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .sum();
    assert_eq!(failures, FAILURES);
    assert_eq!(point.snapshot().hits, (THREADS * HITS) as u64);
}

#[test]
fn dropping_an_old_guard_does_not_clear_a_new_configuration() {
    let point = Injector::new().point("request");
    let old = point.scoped(Action::Return(500)).unwrap();
    let current = point.scoped(Action::Return(503)).unwrap();
    drop(old);
    assert_eq!(point.hit(), ControlFlow::Break(503));
    current.release();
    current.release();
    assert_eq!(point.hit(), ControlFlow::Continue(()));

    let old = point.scoped(Action::Return(500)).unwrap();
    point.set(Action::Return(503)).unwrap();
    drop(old);
    assert_eq!(point.hit(), ControlFlow::Break(503));
}

#[tokio::test]
async fn async_pause_yields_and_guard_release_wakes_the_request() {
    let faults = Injector::<u16>::new();
    let point = faults.point("s3.get.before");
    assert_eq!(point.hit(), ControlFlow::Continue(()));
    let guard = point.scoped(Action::Pause).unwrap();
    assert_eq!(guard.snapshot().hits, 0);
    let request_point = point.clone();
    let request = tokio::spawn(async move { request_point.hit_async().await });

    let ready = tokio::time::timeout(Duration::from_secs(10), guard.wait_for_hits(1))
        .await
        .expect("request reaches its configured pause");
    assert_eq!(ready.hits, 1);
    assert_eq!(ready.paused, 1);
    assert_eq!(point.snapshot().hits, 2);
    assert!(!request.is_finished());
    assert_eq!(
        faults.point("unrelated").hit_async().await,
        ControlFlow::Continue(())
    );

    guard.release();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), request)
            .await
            .expect("release wakes the request")
            .unwrap(),
        ControlFlow::Continue(())
    );
    // Observations retain the selection even after its request has resumed.
    assert_eq!(guard.snapshot().paused, 1);
}

#[tokio::test]
async fn cancelling_a_paused_request_consumes_its_finite_selection() {
    let point = Injector::<u16>::new().point("request");
    let guard = point
        .scoped(Action::Pause.times(1).or_else(Action::Return(503)))
        .unwrap();
    let request_point = point.clone();
    let request = tokio::spawn(async move { request_point.hit_async().await });
    tokio::time::timeout(Duration::from_secs(10), guard.wait_for_pauses(1))
        .await
        .expect("request reaches its configured pause");

    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    assert_eq!(guard.snapshot().paused, 1);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), point.hit_async())
            .await
            .expect("the cancelled selection cannot pause a second request"),
        ControlFlow::Break(503)
    );
    assert_eq!(guard.snapshot().triggered, 2);
    assert_eq!(guard.snapshot().paused, 1);
    guard.release();
    assert_eq!(point.hit_async().await, ControlFlow::Continue(()));
}

#[test]
fn synchronous_macro_returns_a_typed_application_result() {
    fn request(point: &Point<S3Fault>) -> Result<&'static str, S3Fault> {
        faultline::fail_point!(point, |fault| Err(fault));
        Ok("served")
    }

    let point = Injector::new().point("request");
    point
        .set(Action::Return(S3Fault::SlowDown).times(1))
        .unwrap();
    assert_eq!(request(&point), Err(S3Fault::SlowDown));
    assert_eq!(request(&point), Ok("served"));
}

#[tokio::test]
async fn return_mappers_capture_request_ownership_only_when_selected() {
    fn sync_request(point: &Point<()>, request: String, constructed: &AtomicUsize) -> String {
        faultline::fail_point!(point, {
            constructed.fetch_add(1, Ordering::SeqCst);
            move |()| format!("fault:{request}")
        });
        request
    }

    async fn async_request(
        point: &Point<()>,
        request: String,
        constructed: &AtomicUsize,
    ) -> String {
        faultline::fail_point_async!(point, {
            constructed.fetch_add(1, Ordering::SeqCst);
            move |()| format!("fault:{request}")
        });
        request
    }

    let point = Injector::new().point("request");
    let constructed = AtomicUsize::new(0);
    assert_eq!(
        sync_request(&point, "first".to_owned(), &constructed),
        "first"
    );
    assert_eq!(
        async_request(&point, "second".to_owned(), &constructed).await,
        "second"
    );
    assert_eq!(constructed.load(Ordering::SeqCst), 0);

    point.set(Action::Return(())).unwrap();
    assert_eq!(
        sync_request(&point, "third".to_owned(), &constructed),
        "fault:third"
    );
    assert_eq!(
        async_request(&point, "fourth".to_owned(), &constructed).await,
        "fault:fourth"
    );
    assert_eq!(constructed.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn async_sleep_yields_until_its_tokio_deadline() {
    let point = Injector::<()>::new().point("request");
    let guard = point.scoped(Action::Sleep(Duration::from_secs(5))).unwrap();
    let request_point = point.clone();
    let request = tokio::spawn(async move { request_point.hit_async().await });
    tokio::time::timeout(Duration::from_secs(10), guard.wait_for_hits(1))
        .await
        .expect("request selects its sleep");

    // A separate task must run while the injected sleep remains pending.
    assert_eq!(tokio::spawn(async { "served" }).await.unwrap(), "served");
    assert!(!request.is_finished());
    tokio::time::advance(Duration::from_secs(4)).await;
    tokio::task::yield_now().await;
    assert!(!request.is_finished());
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), request)
            .await
            .expect("request resumes after its deadline")
            .unwrap(),
        ControlFlow::Continue(())
    );
}

#[tokio::test]
async fn clearing_or_replacing_configuration_releases_selected_pauses() {
    #[derive(Clone, Copy, Debug)]
    enum Change {
        ClearPoint,
        ClearInjector,
        Replace,
    }

    for change in [Change::ClearPoint, Change::ClearInjector, Change::Replace] {
        let faults = Injector::<u16>::new();
        let point = faults.point("request");
        let guard = point.scoped(Action::Pause).unwrap();
        let request_point = point.clone();
        let request = tokio::spawn(async move { request_point.hit_async().await });
        tokio::time::timeout(Duration::from_secs(10), guard.wait_for_pauses(1))
            .await
            .expect("request selects its pause");

        let next = match change {
            Change::ClearPoint => {
                point.clear();
                ControlFlow::Continue(())
            }
            Change::ClearInjector => {
                faults.clear();
                ControlFlow::Continue(())
            }
            Change::Replace => {
                point.set(Action::Return(503)).unwrap();
                ControlFlow::Break(503)
            }
        };

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(10), request)
                .await
                .unwrap_or_else(|_| panic!("{change:?} did not release the paused request"))
                .unwrap(),
            ControlFlow::Continue(()),
            "an already selected pause does not select the replacement plan"
        );
        assert_eq!(point.hit_async().await, next, "{change:?}");
        assert_eq!(guard.snapshot().hits, 1);
        assert_eq!(guard.snapshot().paused, 1);
    }
}

#[tokio::test]
async fn an_async_coordinator_can_release_a_synchronously_paused_worker() {
    let point = Injector::<()>::new().point("request");
    let guard = point.scoped(Action::Pause).unwrap();
    let worker_point = point.clone();
    let (completed, result) = tokio::sync::oneshot::channel();
    let worker = std::thread::spawn(move || {
        let _ = completed.send(worker_point.hit());
    });
    tokio::time::timeout(Duration::from_secs(10), guard.wait_for_pauses(1))
        .await
        .expect("synchronous worker selects its pause");

    guard.release();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), result)
            .await
            .expect("async coordinator releases the synchronous worker")
            .unwrap(),
        ControlFlow::Continue(())
    );
    worker.join().unwrap();
    assert_eq!(guard.snapshot().paused, 1);
}

#[tokio::test]
async fn buggify_is_an_isolated_branch_decision_shared_by_service_clones() {
    async fn request(faults: &Injector<S3Fault>) -> Result<(), S3Fault> {
        if faultline::buggify!(faults, "s3.slow_down") {
            tokio::task::yield_now().await;
            return Err(S3Fault::SlowDown);
        }
        Ok(())
    }

    let faults = Injector::with_seed(17);
    let other = Injector::with_seed(17);
    assert_eq!(request(&faults).await, Ok(()));
    assert!(faults.buggify().snapshot().is_empty());
    let guard = faults
        .buggify()
        .scoped(BuggifyConfig {
            activation: Probability::ALWAYS,
            firing: Probability::ALWAYS,
        })
        .unwrap();
    let worker_faults = faults.clone();
    assert_eq!(
        tokio::spawn(async move { request(&worker_faults).await })
            .await
            .unwrap(),
        Err(S3Fault::SlowDown)
    );
    assert_eq!(request(&other).await, Ok(()));
    assert_eq!(faults.buggify().snapshot()[0].fired, 1);
    assert_eq!(faults.seed(), 17);
    faults.clear();
    assert_eq!(request(&faults).await, Ok(()));
    drop(guard);
}

#[test]
fn automatic_buggify_sites_are_distinct_and_named_sites_can_share() {
    let faults = Injector::<()>::with_seed(0);
    let _guard = faults
        .buggify()
        .scoped(BuggifyConfig {
            activation: Probability::ALWAYS,
            firing: Probability::ALWAYS,
        })
        .unwrap();
    for _ in 0..3 {
        assert!(faultline::buggify!(faults));
    }
    assert!(faultline::buggify!(faults));
    let sites = faults.buggify().snapshot();
    assert_eq!(sites.len(), 2);
    assert!(sites.iter().all(|site| site.name.contains(file!())));
    assert_eq!(sites.iter().map(|site| site.hits).sum::<u64>(), 4);

    assert!(!faultline::buggify_with_prob!(
        faults,
        "shared",
        Probability::NEVER
    ));
    assert!(faultline::buggify_with_prob!(
        faults,
        "shared",
        Probability::ALWAYS
    ));
    let sites = faults.buggify().snapshot();
    let shared = sites.iter().find(|site| site.name == "shared").unwrap();
    assert!(shared.activated);
    assert_eq!(shared.hits, 2);
    assert_eq!(shared.fired, 1);
}

#[test]
fn buggify_macro_evaluates_arguments_once() {
    let faults = Injector::<()>::with_seed(0);
    let _guard = faults
        .buggify()
        .scoped(BuggifyConfig {
            activation: Probability::ALWAYS,
            firing: Probability::ALWAYS,
        })
        .unwrap();
    let mut injectors = 0;
    let mut names = 0;
    let mut probabilities = 0;
    assert!(faultline::buggify_with_prob!(
        {
            injectors += 1;
            &faults
        },
        {
            names += 1;
            "site"
        },
        {
            probabilities += 1;
            Probability::ALWAYS
        }
    ));
    assert_eq!((injectors, names, probabilities), (1, 1, 1));
}

#[test]
fn simultaneous_buggify_hits_share_one_activation_and_exact_counters() {
    const THREADS: usize = 8;
    const HITS: usize = 128;
    let faults = Injector::<()>::with_seed(19);
    let guard = faults
        .buggify()
        .scoped(BuggifyConfig {
            activation: Probability::ALWAYS,
            firing: Probability::ALWAYS,
        })
        .unwrap();
    let barrier = Arc::new(Barrier::new(THREADS));
    std::thread::scope(|scope| {
        for _ in 0..THREADS {
            let faults = faults.clone();
            let barrier = barrier.clone();
            scope.spawn(move || {
                barrier.wait();
                for _ in 0..HITS {
                    assert!(faultline::buggify!(faults, "s3.shared_site"));
                }
            });
        }
    });
    guard.release();
    assert!(faults.buggify().snapshot().is_empty());
    let sites = guard.snapshot();
    assert_eq!(sites.len(), 1);
    assert!(sites[0].activated);
    assert_eq!(sites[0].hits, (THREADS * HITS) as u64);
    assert_eq!(sites[0].fired, (THREADS * HITS) as u64);
}
