// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

pub fn decode(input: &[u8]) -> Option<u64> {
    let (&tag, payload) = input.split_first()?;
    if tag != b'F' || payload.first().copied()? != b'Z' {
        return None;
    }
    Some(
        payload[1..]
            .iter()
            .fold(0_u64, |state, byte| state.rotate_left(7) ^ u64::from(*byte)),
    )
}
