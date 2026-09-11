// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Disabled instrumentation must disappear in consumers without their own cfg.

use std::ops::ControlFlow;
use std::sync::atomic::{AtomicUsize, Ordering};

use faultline::{Action, BuggifyConfig, Injector};

#[test]
fn disabled_macros_erase_arguments_and_async_requirements() {
    let evaluations = AtomicUsize::new(0);
    let faults = Injector::<u16>::new();

    faultline::fail_point!(
        {
            evaluations.fetch_add(1, Ordering::SeqCst);
            faults.point("sync")
        },
        |fault| Err::<(), _>(fault)
    );
    faultline::fail_point_async!(
        {
            evaluations.fetch_add(1, Ordering::SeqCst);
            faults.point("async")
        },
        |fault| Err::<(), _>(fault)
    );

    // The macro bodies must not require type checking when instrumentation is
    // disabled, including async syntax in this ordinary synchronous function.
    faultline::fail_point!(point_that_does_not_exist, |value: MissingType| {
        missing_mapper(value)
    });
    faultline::fail_point_async!(another_missing_point, |value: MissingType| missing_mapper(
        value
    ));
    faultline::fail_point!(point_that_does_not_exist);
    faultline::fail_point_async!(point_that_does_not_exist);

    assert_eq!(evaluations.load(Ordering::SeqCst), 0);
    assert!(faults.points().is_empty());
}

#[tokio::test]
async fn disabled_direct_api_is_inert_and_rejects_configuration() {
    assert!(!faultline::enabled());
    let faults = Injector::new();
    let point = faults.point("request");

    assert!(faults.configure("request", Action::Return(503)).is_err());
    let string_faults = Injector::<String>::new();
    let _ = string_faults.point("request");
    assert!(
        string_faults
            .configure_str("request", "return(503)")
            .is_err()
    );
    assert!(point.set(Action::Return(503)).is_err());
    assert!(point.scoped(Action::Return(503)).is_err());
    assert_eq!(point.hit(), ControlFlow::Continue(()));
    assert_eq!(point.hit_async().await, ControlFlow::Continue(()));
    assert_eq!(point.snapshot().hits, 0);
    assert_eq!(point.snapshot().triggered, 0);
    assert_eq!(point.snapshot().paused, 0);
    assert!(faults.buggify().enable(BuggifyConfig::default()).is_err());
    assert!(faults.buggify().scoped(BuggifyConfig::default()).is_err());
    assert!(!faults.buggify().test("request"));
    assert!(faults.buggify().snapshot().is_empty());
    point.clear();
    faults.clear();
}

#[test]
fn disabled_buggify_macros_erase_all_arguments_and_return_false() {
    assert!(!faultline::buggify!(missing_injector));
    assert!(!faultline::buggify!(missing_injector, missing_name));
    assert!(!faultline::buggify_with_prob!(
        missing_injector,
        missing_probability
    ));
    assert!(!faultline::buggify_with_prob!(
        missing_injector,
        missing_name,
        missing_probability
    ));
    let evaluations = AtomicUsize::new(0);
    assert!(!faultline::buggify!({
        evaluations.fetch_add(1, Ordering::SeqCst);
        Injector::<()>::new()
    }));
    assert_eq!(evaluations.load(Ordering::SeqCst), 0);
}
