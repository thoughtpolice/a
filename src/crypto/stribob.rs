// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#![warn(unsafe_code)]
#![allow(incomplete_features)]
#![feature(generic_const_exprs)]

//! Symmetric cryptographic library based on a single sponge construction.
//!
//! TODO FIXME (aseipp): lorem ipsum...

pub mod prototype {
    //! TODO FIXME (aseipp): ...

    use super::Domain;

    /// A psuedorandom permutation function (PRP) over a block of state, along
    /// with parameters for usage in sponge designs.
    ///
    /// A PRP is a function that cannot be distinguished from a truly random
    /// permutation of some given state. In practical terms, the state is an
    /// array of bytes `x`, and the underlying function `π(x)` simply modifies
    /// `x` in place. Its behavior is closely related to the function of the
    /// internal permutation inside a block cipher.
    ///
    /// Invariant: the internal state vector MUST be a byte array of exactly
    /// length `B` where `B = R + C`.
    pub trait Perm {
        /// `R` is the rate of the sponge **bytes**. This is the amount of
        /// internal state which is used for absorbing data in, and squeezing
        /// data out.
        const R: usize;

        /// `C` is the capacity of the sponge in **bytes**: the amount of state
        /// which is never touched by absorbtion, nor emitted via squeezing.
        /// When part of a sponge construction, the internal capacity `C`
        /// dictates the overall security level of the sponge.
        const C: usize;

        /// The state permutation function, π ("pi"). This function must modify
        /// the provided state vector of `B` bytes in-place in a way that is
        /// "difficult" to distinguish from a truly random permutation.
        ///
        /// Note: while a given permutation does not itself define a rate or
        /// capacity *per se*, for the purposes of sponge constructions in this
        /// library we only consider unique tuples of `(R, C, pi)` to be of
        /// interest, and thus we tuple them together.
        fn pi(state: &mut [u8; Self::R + Self::C]);
    }

    /// A cryptographic sponge construction. Given an underlying permutation `P:
    /// Perm` and the capacity/rate `P::C`/`P::R`, a sponge [`S<P>`] is created
    /// with a security level of approximately `P::C*8` bits.
    pub struct S<P: Perm>
    where
        [(); P::R + P::C]:,
    {
        pos: usize,
        state: [u8; P::R + P::C],
    }

    /// A secure implementation of [`Drop`] that is guaranteed to zeroize memory
    /// for a given permutation's state vector.
    impl<P: Perm> Drop for S<P>
    where
        [(); P::R + P::C]:,
    {
        /// Secure [`Drop::drop`].
        fn drop(&mut self) {
            self.pos = 0;
            super::zdrop(&mut self.state)
        }
    }

    impl<P: Perm> Default for S<P>
    where
        [(); P::R + P::C]:,
    {
        fn default() -> Self {
            Self::new()
        }
    }

    /// Creating and applying permutations.
    impl<P: Perm> S<P>
    where
        [(); P::R + P::C]:,
    {
        /// Create a new permutation from a given function.
        pub fn new() -> Self {
            Self {
                pos: 0,
                state: [0; P::R + P::C],
            }
        }

        /// Apply a single pass of the state permutation to the internal state
        /// vector.
        pub fn permute(&mut self) {
            P::pi(&mut self.state)
        }
    }

    impl<P: Perm> S<P>
    where
        [(); P::R + P::C]:,
    {
        /// Absorb data into the sponge.
        pub fn absorb(&mut self, data: &[u8], domain: u8) {
            for &byte in data {
                if self.pos == P::R {
                    self.next(domain);
                }

                self.state[self.pos] ^= byte;
                self.pos += 1;
            }
        }

        /// Squeeze data out of the sponge.
        pub fn squeeze(&mut self, out: &mut [u8], domain: u8) {
            let mut pos = 0;
            while pos < out.len() {
                if self.pos == P::R {
                    self.next(domain);
                }

                let available = P::R - self.pos;
                let remaining = out.len() - pos;
                let size = available.min(remaining);

                out[pos..(pos + size)].copy_from_slice(&self.state[self.pos..(self.pos + size)]);

                pos += size;
                self.pos += size;
            }
        }

        /// Encrypt data.
        pub fn encrypt(&mut self, data: &[u8], domain: u8) -> Vec<u8> {
            let mut ct = vec![0; data.len()];

            for (i, &byte) in data.iter().enumerate() {
                if self.pos == P::R {
                    self.next(domain);
                }

                self.state[self.pos] ^= byte;
                ct[i] = self.state[self.pos];
                self.pos += 1;
            }

            ct
        }

        /// Decrypt data.
        pub fn decrypt(&mut self, data: &[u8], domain: u8) -> Vec<u8> {
            let mut pt = vec![0; data.len()];
            for (i, _) in data.iter().enumerate() {
                if self.pos == P::R {
                    self.next(domain);
                }

                let t = data[i];
                pt[i] = self.state[self.pos] ^ t;
                self.state[self.pos] = t;
                self.pos += 1;
            }

            pt
        }

        /// Finalize the current domain.
        pub fn finalize(&mut self, domain: u8) {
            self.state[self.pos] ^= 0x01; // BLNK_END
            self.separate(domain | 0x02); // BLNK_FIN
            self.permute();
            self.pos = 0;
        }

        /// Compare the current rate data to the given input; often used for
        /// verification.
        pub fn compare(&mut self, data: &[u8], domain: u8) -> bool {
            let mut d = 0;
            for (i, _) in data.iter().enumerate() {
                if self.pos == P::R {
                    self.next(domain);
                }

                if d == 0 {
                    d = data[i] as i64 - self.state[self.pos] as i64;
                }

                self.pos += 1;
            }

            d == 0
        }

        /// Erase the current rate in order to prevent rollback attacks.
        pub fn ratchet(&mut self, l: usize) {
            self.next(super::Domain::RATCHET as u8);
            for _ in 0..l {
                if self.pos == P::R {
                    self.next(Domain::RATCHET as u8);
                }

                self.state[self.pos] = 0;
                self.pos += 1;
            }
        }

        /// Utility: separate domains, and permute.
        fn next(&mut self, domain: u8) {
            self.separate(domain | 0x01); // BLNK_END
            self.permute();
            self.pos = 0;
        }

        /// Utility: separate domains
        fn separate(&mut self, domain: u8) {
            self.state[P::R] ^= domain;
        }
    }

    /// Whirlbob permutation, AKA "STRIBOBr2".
    #[derive(Debug, Hash)]
    pub struct Whirlbob;

    impl Perm for Whirlbob {
        const R: usize = 32;
        const C: usize = 32;
        fn pi(state: &mut [u8; Self::R + Self::C]) {
            #![allow(unsafe_code)]
            // SAFETY: we guarantee that,
            //
            // 1. self.state is aligned on a 64b boundary
            // 2. pointer is valid for duration of the call
            // 3. no other references exist (cf. &mut ref)
            unsafe {
                super::ffi::wbob_pi(state.as_mut_ptr());
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn test001() {
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

            /*
            // Decrypt
            let mut sbob = S::new(Whirlbob)
                .with_key(b"s3kr3t")
                .with_nonce(b"12345")
                .with_aad(&[]);

            let pt = sbob.decrypt(&ct);
            let valid = sbob.validate(&tag);

            println!("PT: {:?}", pt);
            println!("Valid: {}", valid);
            println!("OK: {}", pt == secret);

            assert!(valid);
            assert!(pt == secret);
            */
        }
    }
}

#[repr(u8)]
pub enum Domain {
    KEY = 0x10,
    NONCE = 0x20,
    AAD = 0x30,
    MSG = 0x40,
    TAG = 0x50,
    XOF = 0x60,
    KEYXOF = 0x80,
    RATCHET = 0x90,
}

/// Zeroize the given block of bytes. The intent is to use this in the
/// [`Drop::drop`] implementation of a given permutation function.
fn zdrop<const N: usize>(state: &mut [u8; N]) {
    #![allow(unsafe_code)]
    for p in state.iter_mut() {
        unsafe {
            std::ptr::write_volatile(p, 0x0);
        }
    }
}

mod ffi {
    #![allow(unused, unsafe_code, non_upper_case_globals, non_camel_case_types)]
    include!(concat!(env!("WBOB_BINDGEN_H"), "/wbob-pi.rs"));
}
