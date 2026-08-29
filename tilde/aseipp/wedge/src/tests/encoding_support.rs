// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Shared helpers for tests that hand-encode binary modules WABT cannot
//! assemble.

#![allow(dead_code)]

pub fn encode_u32(output: &mut Vec<u8>, mut value: u32) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        output.push(byte | if value == 0 { 0 } else { 0x80 });
        if value == 0 {
            return;
        }
    }
}

pub fn append_section(module: &mut Vec<u8>, id: u8, payload: &[u8]) {
    module.push(id);
    encode_u32(module, payload.len() as u32);
    module.extend_from_slice(payload);
}
