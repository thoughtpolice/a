// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Minimal safe wrapper over BoringSSL's ML-KEM-768 (FIPS 203), exposed
//! through `bssl_sys` from `openssl/mlkem.h`. Covers exactly what the TLS
//! hybrid key exchange needs: key generation, encapsulation-key parsing,
//! encapsulation and decapsulation.

use core::mem::MaybeUninit;

pub(crate) const ENCAP_KEY_LEN: usize = bssl_sys::MLKEM768_PUBLIC_KEY_BYTES as usize;
pub(crate) const CIPHERTEXT_LEN: usize = bssl_sys::MLKEM768_CIPHERTEXT_BYTES as usize;
pub(crate) const SHARED_SECRET_LEN: usize = bssl_sys::MLKEM_SHARED_SECRET_BYTES as usize;

/// An ML-KEM-768 decapsulation (private) key.
///
/// The ~7.6 KiB of key material lives on the heap, and is cleansed on drop.
/// Invariant: the box is fully initialized by [`DecapKey::generate`], the
/// only constructor.
pub(crate) struct DecapKey(Box<MaybeUninit<bssl_sys::MLKEM768_private_key>>);

impl DecapKey {
    /// Generate a fresh key, returning it with its encoded encapsulation
    /// key in the FIPS 203 byte format used directly in TLS key shares.
    pub(crate) fn generate() -> (Self, [u8; ENCAP_KEY_LEN]) {
        let mut key = Box::new(MaybeUninit::uninit());
        let mut encap_key = [0u8; ENCAP_KEY_LEN];
        // SAFETY: the out-pointers denote an ENCAP_KEY_LEN buffer and an
        // uninitialized private key, both of which the call fully
        // initializes; the seed out-pointer is documented as optional.
        unsafe {
            bssl_sys::MLKEM768_generate_key(
                encap_key.as_mut_ptr(),
                core::ptr::null_mut(),
                key.as_mut_ptr(),
            );
        }
        (Self(key), encap_key)
    }

    /// Decapsulate `ciphertext` into `out`.
    ///
    /// Only a wrong-length ciphertext fails. A corrupt ciphertext of the
    /// right length "succeeds" with the implicit-rejection secret, as
    /// FIPS 203 requires; a protocol built on this notices when the two
    /// sides' secrets fail to agree.
    pub(crate) fn decap(
        &self,
        ciphertext: &[u8],
        out: &mut [u8; SHARED_SECRET_LEN],
    ) -> Result<(), ()> {
        // SAFETY: the out-pointer denotes a SHARED_SECRET_LEN buffer, the
        // ciphertext pointer/length denote a valid readable buffer, and the
        // private key is initialized per the type invariant.
        let ok = unsafe {
            bssl_sys::MLKEM768_decap(
                out.as_mut_ptr(),
                ciphertext.as_ptr(),
                ciphertext.len(),
                self.0.as_ptr(),
            )
        };
        if ok == 1 {
            Ok(())
        } else {
            // BoringSSL deliberately fills this output with randomness on a
            // wrong-length input. Do not expose an unauthenticated value to a
            // caller that accidentally uses the buffer after the error.
            crate::cleanse(out);
            Err(())
        }
    }
}

impl Drop for DecapKey {
    fn drop(&mut self) {
        cleanse_private_key(&mut self.0);
    }
}

fn cleanse_private_key(key: &mut MaybeUninit<bssl_sys::MLKEM768_private_key>) {
    // SAFETY: the pointer/length denote exactly the initialized allocation
    // holding the private key material. OPENSSL_cleanse accepts arbitrary
    // bytes and leaves the allocation valid for Box to free.
    unsafe {
        bssl_sys::OPENSSL_cleanse(
            key.as_mut_ptr().cast(),
            core::mem::size_of::<bssl_sys::MLKEM768_private_key>(),
        )
    }
}

/// A parsed and validated ML-KEM-768 encapsulation (public) key.
///
/// Invariant: the box is fully initialized by [`EncapKey::parse`], the only
/// constructor.
pub(crate) struct EncapKey(Box<MaybeUninit<bssl_sys::MLKEM768_public_key>>);

impl EncapKey {
    /// Parse an encoded encapsulation key, enforcing the canonical FIPS 203
    /// encoding (coefficients fully reduced mod q). `None` on any
    /// malformation, including a wrong length.
    pub(crate) fn parse(encoded: &[u8]) -> Option<Self> {
        if encoded.len() != ENCAP_KEY_LEN {
            return None;
        }
        let mut key = Box::new(MaybeUninit::uninit());
        let mut cbs = bssl_sys::CBS {
            data: encoded.as_ptr(),
            len: encoded.len(),
        };
        // SAFETY: `cbs` denotes the `encoded` slice, which outlives the
        // call; on success the out-pointer's key is fully initialized.
        let ok = unsafe { bssl_sys::MLKEM768_parse_public_key(key.as_mut_ptr(), &mut cbs) };
        (ok == 1 && cbs.len == 0).then_some(Self(key))
    }

    /// Encapsulate a fresh shared secret to this key.
    pub(crate) fn encap(
        &self,
        ciphertext: &mut [u8; CIPHERTEXT_LEN],
        out: &mut [u8; SHARED_SECRET_LEN],
    ) {
        // SAFETY: the out-pointers denote buffers of exactly the lengths
        // the call writes, and the public key is initialized per the type
        // invariant.
        unsafe {
            bssl_sys::MLKEM768_encap(ciphertext.as_mut_ptr(), out.as_mut_ptr(), self.0.as_ptr())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::mem::ManuallyDrop;

    use super::*;

    #[test]
    fn encap_decap_roundtrip() {
        let (decap_key, encoded) = DecapKey::generate();
        let encap_key = EncapKey::parse(&encoded).unwrap();

        let mut ciphertext = [0u8; CIPHERTEXT_LEN];
        let mut sent = [0u8; SHARED_SECRET_LEN];
        encap_key.encap(&mut ciphertext, &mut sent);
        assert_ne!(sent, [0u8; SHARED_SECRET_LEN]);

        let mut received = [0u8; SHARED_SECRET_LEN];
        decap_key.decap(&ciphertext, &mut received).unwrap();
        assert_eq!(sent, received);
    }

    #[test]
    fn parse_rejects_wrong_lengths() {
        for len in [0, ENCAP_KEY_LEN - 1, ENCAP_KEY_LEN + 1] {
            assert!(EncapKey::parse(&vec![0u8; len]).is_none());
        }
    }

    #[test]
    fn parse_rejects_unreduced_coefficients() {
        // 0xff-saturated coefficients are >= q, which the canonical
        // FIPS 203 encoding forbids.
        assert!(EncapKey::parse(&[0xff; ENCAP_KEY_LEN]).is_none());
    }

    #[test]
    fn decap_rejects_wrong_ciphertext_lengths() {
        let (decap_key, _) = DecapKey::generate();
        for len in [0, CIPHERTEXT_LEN - 1, CIPHERTEXT_LEN + 1] {
            let mut out = [0xa5u8; SHARED_SECRET_LEN];
            assert!(decap_key.decap(&vec![0u8; len], &mut out).is_err());
            assert_eq!(out, [0u8; SHARED_SECRET_LEN]);
        }
    }

    #[test]
    fn corrupt_ciphertext_implicitly_rejects() {
        let (decap_key, encoded) = DecapKey::generate();
        let encap_key = EncapKey::parse(&encoded).unwrap();

        let mut ciphertext = [0u8; CIPHERTEXT_LEN];
        let mut sent = [0u8; SHARED_SECRET_LEN];
        encap_key.encap(&mut ciphertext, &mut sent);

        ciphertext[0] ^= 1;
        let mut received_a = [0u8; SHARED_SECRET_LEN];
        let mut received_b = [0u8; SHARED_SECRET_LEN];
        decap_key.decap(&ciphertext, &mut received_a).unwrap();
        decap_key.decap(&ciphertext, &mut received_b).unwrap();
        assert_ne!(
            sent, received_a,
            "implicit rejection must not leak agreement"
        );
        assert_eq!(
            received_a, received_b,
            "implicit rejection must be deterministic for a key and ciphertext"
        );
    }

    #[test]
    fn private_key_storage_is_cleansed_before_free() {
        let (key, _) = DecapKey::generate();
        let mut key = ManuallyDrop::new(key);
        cleanse_private_key(&mut key.0);

        // SAFETY: ManuallyDrop keeps the allocation alive while it is
        // inspected. Afterwards the normal Drop path cleanses it again and
        // frees it exactly once.
        let bytes = unsafe {
            core::slice::from_raw_parts(
                key.0.as_ptr().cast::<u8>(),
                core::mem::size_of::<bssl_sys::MLKEM768_private_key>(),
            )
        };
        assert!(bytes.iter().all(|&byte| byte == 0));
        drop(ManuallyDrop::into_inner(key));
    }

    #[test]
    fn rejected_inputs_do_not_pollute_the_openssl_error_queue() {
        drop(openssl::error::ErrorStack::get());
        assert!(EncapKey::parse(&[0xff; ENCAP_KEY_LEN]).is_none());
        let (decap_key, _) = DecapKey::generate();
        let mut out = [0u8; SHARED_SECRET_LEN];
        assert!(decap_key.decap(&[], &mut out).is_err());
        assert!(openssl::error::ErrorStack::get().errors().is_empty());
    }
}
