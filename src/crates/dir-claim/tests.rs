// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::os::unix::fs::PermissionsExt as _;

use serde::{Deserialize, Serialize};

use crate::{Claim, Files, TakeError, holder};

const FILES: Files = Files {
    lock: "test.lock",
    state: "state.json",
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct State {
    pid: u32,
    address: String,
}

fn state() -> State {
    State {
        pid: 4321,
        address: "127.0.0.1:8980".into(),
    }
}

#[test]
fn a_second_claim_is_refused_until_the_first_is_dropped() {
    let scratch = tempfile::tempdir().unwrap();
    let dir = scratch.path().join("created");
    let first = Claim::<State>::take(&dir, FILES).expect("first claim");
    assert_eq!(first.dir(), dir);

    match Claim::<State>::take(&dir, FILES) {
        Err(TakeError::Held { lock, holder: None }) => assert_eq!(lock, dir.join(FILES.lock)),
        other => panic!("a second claim: {other:?}"),
    }

    first.announce(&state()).unwrap();
    assert_eq!(holder(&dir, FILES), Some(state()));
    match Claim::<State>::take(&dir, FILES) {
        Err(TakeError::Held { holder, .. }) => assert_eq!(holder, Some(state())),
        other => panic!("a second claim: {other:?}"),
    }

    drop(first);
    assert_eq!(
        holder::<State>(&dir, FILES),
        None,
        "the state goes with the claim"
    );
    Claim::<State>::take(&dir, FILES).expect("claim once released");
}

#[test]
fn the_state_is_the_owners_alone_and_written_whole() {
    let scratch = tempfile::tempdir().unwrap();
    let claim = Claim::<State>::take(scratch.path(), FILES).unwrap();
    claim.announce(&state()).unwrap();
    let path = scratch.path().join(FILES.state);
    let mode = std::fs::metadata(&path).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
    assert!(!scratch.path().join("state.json.partial").exists());
    assert!(std::fs::read_to_string(&path).unwrap().ends_with("}\n"));
}

#[test]
fn a_state_of_another_shape_reads_as_none() {
    let scratch = tempfile::tempdir().unwrap();
    std::fs::write(scratch.path().join(FILES.state), b"{\"other\": true}").unwrap();
    assert_eq!(holder::<State>(scratch.path(), FILES), None);
}

#[test]
fn a_directory_that_cannot_be_made_is_an_error() {
    let scratch = tempfile::tempdir().unwrap();
    let file = scratch.path().join("file");
    std::fs::write(&file, b"").unwrap();
    let err = Claim::<State>::take(&file.join("dir"), FILES).unwrap_err();
    assert!(matches!(err, TakeError::Failed(_)), "{err:?}");
    assert!(
        err.to_string()
            .starts_with("failed to create the directory"),
        "{err}"
    );
}
