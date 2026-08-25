// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn parses_bounded_command_line_durations() {
    assert_eq!(
        "250ms".parse::<HumanDuration>().unwrap().0,
        Duration::from_millis(250)
    );
    assert_eq!(
        "10s".parse::<HumanDuration>().unwrap().0,
        Duration::from_secs(10)
    );
    assert_eq!(
        "2m".parse::<HumanDuration>().unwrap().0,
        Duration::from_secs(120)
    );
    for invalid in ["", "10", "0s", "-1s", "forever"] {
        assert!(
            invalid.parse::<HumanDuration>().is_err(),
            "accepted {invalid:?}"
        );
    }
}
