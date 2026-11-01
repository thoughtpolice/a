// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#![no_main]

#[cfg(not(fozzie_asan))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use serde_json::Value;

// Any JSON value that parses must survive a round trip. Its text must parse
// back to an equal value, and writing that value again must give the same
// text. Exact equality needs serde_json's float_roundtrip feature, which
// the third-party build enables.
fozzie::fuzz_target!(|data: &[u8]| -> i32 {
    let Ok(value) = serde_json::from_slice::<Value>(data) else {
        return 0;
    };
    let text = serde_json::to_vec(&value).expect("a Value always serializes");
    let again = match serde_json::from_slice::<Value>(&text) {
        Ok(again) => again,
        Err(error) => {
            eprintln!("{} does not parse back: {error}", text.escape_ascii());
            return 1;
        }
    };
    if again != value {
        eprintln!("{} parses back as {again}", text.escape_ascii());
        return 2;
    }
    let text_again = serde_json::to_vec(&again).expect("a Value always serializes");
    if text_again != text {
        eprintln!(
            "{} is written again as {}",
            text.escape_ascii(),
            text_again.escape_ascii()
        );
        return 3;
    }
    0
});
