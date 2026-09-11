// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A client retry loop tested against named, text-configured failpoints.
//!
//! The service binds its points once at construction and maps typed faults
//! into its own error type. The "test" half configures plans from strings,
//! the way a `--failpoint NAME=PLAN` flag would, and checks the counters.

use std::fmt;
use std::ops::ControlFlow;
use std::str::FromStr;

use faultline::{ConfigError, Injector, Point};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fault {
    SlowDown,
    NotFound,
}

impl FromStr for Fault {
    type Err = String;

    fn from_str(input: &str) -> Result<Self, Self::Err> {
        match input {
            "SlowDown" => Ok(Self::SlowDown),
            "NotFound" => Ok(Self::NotFound),
            other => Err(format!("unknown fault {other:?}")),
        }
    }
}

impl fmt::Display for Fault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}

struct Service {
    before_get: Point<Fault>,
}

impl Service {
    fn new(faults: &Injector<Fault>) -> Self {
        Self {
            before_get: faults.point("service.get.before"),
        }
    }

    fn get(&self, key: &str) -> Result<String, Fault> {
        if let ControlFlow::Break(fault) = self.before_get.hit() {
            return Err(fault);
        }
        Ok(format!("contents of {key}"))
    }
}

/// Retries throttling, but gives up immediately on anything else.
fn get_with_retry(service: &Service, key: &str, attempts: u32) -> Result<String, Fault> {
    let mut last = Fault::SlowDown;
    for attempt in 1..=attempts {
        match service.get(key) {
            Err(Fault::SlowDown) => {
                println!("  attempt {attempt}: SlowDown, retrying");
                last = Fault::SlowDown;
            }
            result => return result,
        }
    }
    Err(last)
}

fn main() -> Result<(), ConfigError> {
    let faults = Injector::new();
    let service = Service::new(&faults);
    println!("declared points: {:?}", faults.points());

    println!("two throttles, then recovery:");
    faults.configure_str("service.get.before", "2*return(SlowDown)")?;
    let value = get_with_retry(&service, "a", 5);
    println!("  -> {value:?}");
    assert_eq!(value.as_deref(), Ok("contents of a"));
    assert_eq!(service.before_get.snapshot().triggered, 2);

    println!("throttling outlasts the retry budget:");
    faults.configure_str("service.get.before", "return(SlowDown)")?;
    let value = get_with_retry(&service, "b", 3);
    println!("  -> {value:?}");
    assert_eq!(value, Err(Fault::SlowDown));

    println!("a non-retryable fault after one throttle:");
    faults.configure_str("service.get.before", "1*return(SlowDown)->return(NotFound)")?;
    let value = get_with_retry(&service, "c", 5);
    println!("  -> {value:?}");
    assert_eq!(value, Err(Fault::NotFound));

    // Mistakes in setup are reported rather than silently ignored.
    let typo = faults.configure_str("service.get.bfore", "return(SlowDown)");
    println!("misspelled point: {}", typo.unwrap_err());
    let bad = faults.configure_str("service.get.before", "return(Throttled)");
    println!("bad payload: {}", bad.unwrap_err());

    faults.clear();
    assert!(get_with_retry(&service, "d", 1).is_ok());
    println!("lifetime observations: {:?}", service.before_get.snapshot());
    Ok(())
}
