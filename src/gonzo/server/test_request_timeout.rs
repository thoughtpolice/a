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
const EXECUTE: &str = "/build.bazel.remote.execution.v2.Execution/Execute";

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

/// A response body that arrives whenever its sender sends it, as a
/// streamed response's does.
#[derive(Default)]
struct Later(Option<tokio::sync::oneshot::Receiver<&'static str>>);

#[tokio::test(start_paused = true)]
async fn a_response_once_started_may_stream_past_the_limit() {
    let timeouts = RequestTimeouts {
        default: Some(Duration::from_secs(900)),
        fetch: Some(Duration::from_secs(1802)),
    };
    let (send, body) = tokio::sync::oneshot::channel();
    let mut body = Some(body);
    // Answers at once, as Execute does with the stream of its stages.
    let at_once = tower::service_fn(move |_req: hyper::Request<()>| {
        let body = body.take();
        async move { Ok::<_, std::convert::Infallible>(hyper::Response::new(Later(body))) }
    });
    let mut svc = RequestTimeout::new(at_once, timeouts);
    let req = hyper::Request::builder().uri(EXECUTE).body(()).unwrap();
    let response = svc.ready().await.unwrap().call(req).await.unwrap();
    assert!(response.headers().get("grpc-status").is_none());

    // An hour on, past every limit the server sets, the body still comes.
    tokio::time::sleep(Duration::from_secs(3600)).await;
    send.send("done").unwrap();
    let Later(Some(body)) = response.into_body() else {
        panic!("the body was not passed through");
    };
    assert_eq!(body.await.unwrap(), "done");
}
