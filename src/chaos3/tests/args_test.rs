// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use super::parse_args;

fn parse(args: &[&str]) -> Result<Option<super::Args>, String> {
    parse_args(args.iter().map(|arg| (*arg).to_owned()))
}

#[test]
fn defaults_create_celld_on_the_documented_address() {
    let args = parse(&[]).unwrap().unwrap();
    assert_eq!(args.listen.to_string(), "127.0.0.1:9000");
    assert_eq!(args.buckets, ["celld"]);
    assert!(args.failpoints.is_empty());
    assert!(args.fault_seed.is_none());
    assert!(args.ready_fd.is_none());
    assert!(args.chaos.is_none());
    assert!(!args.list_failpoints);
}

#[test]
fn automatic_campaign_parses_counts_and_rejects_ambiguous_configuration() {
    let args = parse(&[
        "--chaos-warmup-requests=20",
        "--chaos-requests",
        "200",
        "--chaos-trace",
        "--chaos=storage-v1",
        "--fault-seed=42",
    ])
    .unwrap()
    .unwrap();
    assert_eq!(
        args.chaos,
        Some(crate::chaos::ChaosConfig {
            warmup_requests: 20,
            requests: Some(200),
            trace: true,
        })
    );
    assert_eq!(
        parse(&["--chaos", "storage-v1"]).unwrap().unwrap().chaos,
        Some(crate::chaos::ChaosConfig::default())
    );
    // Maximum values are accepted without overflowing phase calculations.
    assert!(
        parse(&[
            "--chaos=storage-v1",
            "--chaos-requests=18446744073709551615"
        ])
        .is_ok()
    );
    assert!(
        parse(&[
            "--chaos=storage-v1",
            "--chaos-warmup-requests=18446744073709551614",
            "--chaos-requests=1"
        ])
        .is_ok()
    );
    for (args, expected) in [
        (vec!["--chaos-trace"], "require --chaos"),
        (vec!["--chaos-warmup-requests=0"], "require --chaos"),
        (vec!["--chaos-requests=1"], "require --chaos"),
        (
            vec!["--chaos=storage-v1", "--chaos-requests=0"],
            "must be positive",
        ),
        (
            vec!["--chaos=storage-v1", "--chaos-requests=-1"],
            "invalid --chaos-requests",
        ),
        (
            vec![
                "--chaos=storage-v1",
                "--chaos-warmup-requests=18446744073709551616",
            ],
            "invalid --chaos-warmup-requests",
        ),
        (
            vec!["--chaos=storage-v1", "--chaos-requests"],
            "requires an unsigned",
        ),
        (
            vec![
                "--chaos=storage-v1",
                "--chaos-warmup-requests=1",
                "--chaos-requests=18446744073709551615",
            ],
            "exceeds",
        ),
        (
            vec!["--chaos=storage-v1", "--failpoint=s3.get_object.before=off"],
            "incompatible",
        ),
        (vec!["--chaos"], "--chaos requires a profile name"),
        (vec!["--chaos=storage-v2"], "unknown chaos profile"),
        (vec!["--chaos", "--chaos-trace"], "unknown chaos profile"),
    ] {
        let error = parse(&args).unwrap_err();
        assert!(error.contains(expected), "{args:?}: {error}");
    }
}

#[test]
fn parses_typed_fault_plans_and_seeds_in_both_forms() {
    use crate::faults::{BodyFault, FaultPlan, S3Fault};
    use faultline::Action;

    let args = parse(&[
        "--failpoint=s3.get_object.before=2*return(SlowDown)",
        "--failpoint",
        "s3.put_object.after_commit=return",
        "--failpoint=s3.get_object.body=1*off->return(truncate)",
        "--fault-seed=18446744073709551615",
    ])
    .unwrap()
    .unwrap();
    assert_eq!(
        args.failpoints,
        [
            (
                "s3.get_object.before".to_owned(),
                FaultPlan::Error(Action::Return(S3Fault::SlowDown).times(2).into())
            ),
            (
                "s3.put_object.after_commit".to_owned(),
                FaultPlan::Error(Action::Return(S3Fault::InternalError).into())
            ),
            (
                "s3.get_object.body".to_owned(),
                FaultPlan::Body(
                    Action::Off
                        .times(1)
                        .or_else(Action::Return(BodyFault::Truncate))
                )
            ),
        ]
    );
    assert_eq!(args.fault_seed, Some(u64::MAX));
    let args = parse(&["--fault-seed", "0"]).unwrap().unwrap();
    assert_eq!(args.fault_seed, Some(0));
}

#[test]
fn rejects_fault_configuration_that_would_silently_weaken_a_test() {
    for (args, expected) in [
        (vec!["--failpoint"], "--failpoint requires NAME=PLAN"),
        (vec!["--failpoint="], "--failpoint requires NAME=PLAN"),
        (vec!["--failpoint=missing=return"], "unknown failpoint"),
        (
            vec!["--failpoint=s3.get_object.before="],
            "expected an action",
        ),
        (
            vec!["--failpoint=s3.get_object.before=return(NoSuchError)"],
            "invalid return payload",
        ),
        (
            vec!["--failpoint=s3.get_object.before=return(truncate)"],
            "unknown S3 fault",
        ),
        (
            vec!["--failpoint=s3.get_object.body=return(SlowDown)"],
            "unknown body fault",
        ),
        (
            vec!["--failpoint=s3.get_object.before=NaN%return"],
            "percentage must be finite",
        ),
        (
            vec![
                "--failpoint=s3.get_object.before=off",
                "--failpoint=s3.get_object.before=return",
            ],
            "duplicate --failpoint",
        ),
        (vec!["--fault-seed"], "--fault-seed requires"),
        (vec!["--fault-seed=-1"], "invalid --fault-seed"),
        (
            vec!["--fault-seed=18446744073709551616"],
            "invalid --fault-seed",
        ),
    ] {
        let error = parse(&args).unwrap_err();
        assert!(error.contains(expected), "{args:?}: {error}");
    }
}

#[test]
fn every_advertised_point_is_bound_in_a_fresh_store() {
    let args = parse(&["--list-failpoints"]).unwrap().unwrap();
    assert!(args.list_failpoints);
    let store = crate::memory::MemoryS3::default();
    let mut advertised = crate::faults::POINT_NAMES.to_vec();
    advertised.sort_unstable();
    assert_eq!(advertised, store.faults().points());
    for name in advertised {
        assert!(parse(&["--failpoint", &format!("{name}=return")]).is_ok());
    }
}

#[test]
fn accepts_both_option_forms_and_repeated_buckets() {
    let args = parse(&[
        "--listen",
        "127.0.0.1:0",
        "--bucket=first",
        "--bucket",
        "second",
    ])
    .unwrap()
    .unwrap();
    assert_eq!(args.listen.to_string(), "127.0.0.1:0");
    assert_eq!(args.buckets, ["first", "second"]);
    let args = parse(&["--listen=[::1]:1234", "--ready-fd=3"])
        .unwrap()
        .unwrap();
    assert_eq!(args.listen.to_string(), "[::1]:1234");
    assert_eq!(args.buckets, ["celld"]);
    assert_eq!(args.ready_fd, Some(3));
    assert_eq!(
        parse(&["--ready-fd", "0"]).unwrap().unwrap().ready_fd,
        Some(0)
    );
}

#[test]
fn help_does_not_start_a_server() {
    for flag in ["-h", "--help"] {
        assert!(parse(&[flag]).unwrap().is_none());
    }
}

#[test]
fn rejects_invalid_options_and_missing_values() {
    for (args, error) in [
        (vec!["--bucket"], "--bucket requires a name"),
        (vec!["--bucket", ""], "--bucket names cannot be empty"),
        (vec!["--bucket="], "--bucket names cannot be empty"),
        (vec!["--listen"], "--listen requires an address"),
        (vec!["--listen="], "invalid --listen address"),
        (vec!["--listen=localhost:9000"], "invalid --listen address"),
        (vec!["--listen=127.0.0.1:65536"], "invalid --listen address"),
        (
            vec!["--listen=--listen=127.0.0.1:0"],
            "invalid --listen address",
        ),
        (
            vec!["--ready-fd"],
            "--ready-fd requires a descriptor number",
        ),
        (vec!["--ready-fd=-1"], "invalid --ready-fd"),
        (vec!["--ready-fd=three"], "invalid --ready-fd"),
        (vec!["--unknown"], "unknown argument"),
        (vec!["positional"], "unknown argument"),
    ] {
        let actual = parse(&args).unwrap_err();
        assert!(actual.contains(error), "{args:?}: {actual}");
    }
}

#[test]
fn accepts_bucket_names_and_preserves_the_whole_equals_value() {
    let args = parse(&["--bucket=my.bucket-01"]).unwrap().unwrap();
    assert_eq!(args.buckets, ["my.bucket-01"]);
}

#[test]
fn rejects_bucket_names_the_protocol_layer_cannot_route() {
    for name in ["ab", "My_Bucket", "bucket_underscore", "127.0.0.1"] {
        let error = parse(&["--bucket", name]).unwrap_err();
        assert!(error.contains("invalid --bucket name"), "{name}: {error}");
    }
    // The equals form still takes the whole value before it is validated.
    let error = parse(&["--bucket=--bucket=name"]).unwrap_err();
    assert!(
        error.contains("invalid --bucket name") && error.contains("--bucket=name"),
        "{error}"
    );
}
