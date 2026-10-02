// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::time::Duration;

use tower::{Service as _, ServiceExt as _};

use crate::request_timeout::{RequestTimeout, RequestTimeouts};

/// A service answering after `delay`.
fn slow(
    delay: Duration,
) -> impl tower::Service<
    hyper::Request<()>,
    Response = hyper::Response<String>,
    Error = std::convert::Infallible,
    Future = impl Send + 'static,
> + Clone {
    tower::service_fn(move |_req: hyper::Request<()>| async move {
        tokio::time::sleep(delay).await;
        Ok::<_, std::convert::Infallible>(hyper::Response::new("done".to_string()))
    })
}

async fn call(
    svc: &mut RequestTimeout<
        impl tower::Service<
            hyper::Request<()>,
            Response = hyper::Response<String>,
            Error = std::convert::Infallible,
            Future = impl Send + 'static,
        >,
    >,
    path: &str,
) -> hyper::Response<String> {
    let req = hyper::Request::builder().uri(path).body(()).unwrap();
    svc.ready().await.unwrap().call(req).await.unwrap()
}

const FETCH_DIRECTORY: &str = "/build.bazel.remote.asset.v1.Fetch/FetchDirectory";
const FIND_MISSING: &str =
    "/build.bazel.remote.execution.v2.ContentAddressableStorage/FindMissingBlobs";

#[tokio::test(start_paused = true)]
async fn fetches_get_their_own_limit() {
    let timeouts = RequestTimeouts {
        default: Some(Duration::from_secs(900)),
        fetch: Some(Duration::from_secs(1802)),
    };
    // Twenty minutes: past the default limit, within the fetch limit.
    let mut svc = RequestTimeout::new(slow(Duration::from_secs(1200)), timeouts);

    let fetch = call(&mut svc, FETCH_DIRECTORY).await;
    assert_eq!(fetch.body(), "done");
    assert!(fetch.headers().get("grpc-status").is_none());

    let other = call(&mut svc, FIND_MISSING).await;
    assert_eq!(other.headers()["grpc-status"], "4");
    assert_eq!(other.body(), "");
}

#[tokio::test(start_paused = true)]
async fn a_fetch_past_its_limit_is_cut_off() {
    let timeouts = RequestTimeouts {
        default: None,
        fetch: Some(Duration::from_secs(60)),
    };
    let mut svc = RequestTimeout::new(slow(Duration::from_secs(61)), timeouts);
    let fetch = call(&mut svc, FETCH_DIRECTORY).await;
    assert_eq!(fetch.headers()["grpc-status"], "4");
    assert!(
        fetch.headers()["grpc-message"]
            .to_str()
            .unwrap()
            .contains("60s"),
    );
    // No default limit: anything else may take as long as it takes.
    assert_eq!(call(&mut svc, FIND_MISSING).await.body(), "done");
}
