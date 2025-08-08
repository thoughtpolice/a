// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#![allow(incomplete_features)]
#![feature(generic_const_exprs)]

use stribob::{
    prototype::{Whirlbob, S},
    Domain,
};

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    let secret = b"super secret data";
    let key = b"s3kr3t";
    let nonce = b"12345";
    let aad = b"Hello world!";

    let mut sbob = S::<Whirlbob>::new();

    sbob.absorb(key, Domain::KEY as u8);
    sbob.finalize(Domain::KEY as u8);

    sbob.absorb(nonce, Domain::NONCE as u8);
    sbob.finalize(Domain::NONCE as u8);

    sbob.absorb(aad, Domain::AAD as u8);
    sbob.finalize(Domain::AAD as u8);

    let ct = sbob.encrypt(secret, Domain::MSG as u8);
    sbob.finalize(Domain::MSG as u8);

    let mut tag = vec![0u8; 16];
    sbob.squeeze(&mut tag, Domain::TAG as u8);
    sbob.finalize(Domain::TAG as u8);

    println!("ST: {:?}", secret);
    println!("CT: {:?}", ct);
    println!("MAC tag: {:?}", tag);
}
