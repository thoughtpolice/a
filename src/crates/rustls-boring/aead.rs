// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! TLS 1.3 record protection, plus the shared `EVP_AEAD` engine used by
//! every suite (AES-128-GCM, AES-256-GCM, ChaCha20-Poly1305) for both TLS
//! records and QUIC packets.
//!
//! Record and packet AEADs go through BoringSSL's `EVP_AEAD` interface via
//! `bssl_sys` rather than the `openssl` crate: the `EVP_CIPHER`-based entry
//! points there rebuild the cipher context (including the AES key schedule)
//! and allocate scratch buffers on every call, which is the wrong shape for
//! a per-record/per-packet hot path. An [`AeadCtx`] runs the key schedule
//! once per traffic key, and all sealing/opening is in place.

use rustls::Error;
use rustls::crypto::cipher::{
    AeadKey, InboundOpaqueMessage, InboundPlainMessage, Iv, MessageDecrypter, MessageEncrypter,
    Nonce, OutboundOpaqueMessage, OutboundPlainMessage, PrefixedPayload, Tls13AeadAlgorithm,
    UnsupportedOperationError, make_tls13_aad,
};
use rustls::{ConnectionTrafficSecrets, ContentType, ProtocolVersion};

pub(crate) const TAG_LEN: usize = 16;

pub(crate) static AES_128_GCM: Tls13Aead = Tls13Aead(AeadKind::Aes128Gcm);
pub(crate) static AES_256_GCM: Tls13Aead = Tls13Aead(AeadKind::Aes256Gcm);
pub(crate) static CHACHA20_POLY1305: Tls13Aead = Tls13Aead(AeadKind::ChaCha20Poly1305);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AeadKind {
    Aes128Gcm,
    Aes256Gcm,
    ChaCha20Poly1305,
}

impl AeadKind {
    fn evp(self) -> *const bssl_sys::EVP_AEAD {
        // SAFETY: these functions return static algorithm descriptors.
        unsafe {
            match self {
                Self::Aes128Gcm => bssl_sys::EVP_aead_aes_128_gcm(),
                Self::Aes256Gcm => bssl_sys::EVP_aead_aes_256_gcm(),
                Self::ChaCha20Poly1305 => bssl_sys::EVP_aead_chacha20_poly1305(),
            }
        }
    }

    pub(crate) fn key_len(self) -> usize {
        match self {
            Self::Aes128Gcm => 16,
            Self::Aes256Gcm | Self::ChaCha20Poly1305 => 32,
        }
    }
}

/// Owning handle to an `EVP_AEAD_CTX`, keyed once per traffic key.
///
/// BoringSSL runs the key schedule at creation time, so the seal/open calls
/// below are allocation-free. The context lives as long as the rustls
/// encrypter/decrypter or QUIC packet key that owns it. Its `Drop`
/// implementation explicitly cleanses the keyed state before freeing it;
/// BoringSSL's AES-GCM AEAD cleanup hook is intentionally a no-op.
pub(crate) struct AeadCtx(*mut bssl_sys::EVP_AEAD_CTX);

/// Preserve errors that predate a raw BoringSSL operation while discarding
/// any diagnostics it adds. The `openssl` crate normally drains errors at its
/// API boundary; raw `bssl_sys` calls need to do that bookkeeping themselves.
struct ErrorQueueGuard {
    marked_existing_error: bool,
}

impl ErrorQueueGuard {
    fn new() -> Self {
        // SAFETY: this only marks the calling thread's most recent queued
        // error, if one exists, and has no pointer preconditions.
        let marked_existing_error = unsafe { bssl_sys::ERR_set_mark() == 1 };
        Self {
            marked_existing_error,
        }
    }
}

impl Drop for ErrorQueueGuard {
    fn drop(&mut self) {
        // SAFETY: both operations affect only the calling thread's queue. A
        // successful mark remains valid until this guard removes errors above
        // it; with no pre-existing error, the queue contains only diagnostics
        // produced during the guarded operation and can be cleared wholesale.
        unsafe {
            if self.marked_existing_error {
                let _ = bssl_sys::ERR_pop_to_mark();
            } else {
                bssl_sys::ERR_clear_error();
            }
        }
    }
}

// SAFETY: BoringSSL documents (aead.h) that seal/open "may be called
// concurrently with itself or any other seal/open function on the same
// EVP_AEAD_CTX". The context is immutable after creation and freed exactly
// once by Drop.
unsafe impl Send for AeadCtx {}
unsafe impl Sync for AeadCtx {}

impl Drop for AeadCtx {
    fn drop(&mut self) {
        // SAFETY: the pointer came from `EVP_AEAD_CTX_new` and is cleaned and
        // freed exactly once. Cleanup releases any algorithm-specific owned
        // allocations; cleansing then destroys the inline key schedule. The
        // subsequent free sees a zero/null algorithm pointer, so its second
        // cleanup call is a no-op.
        unsafe {
            cleanup_and_cleanse(self.0);
            bssl_sys::EVP_AEAD_CTX_free(self.0);
        }
    }
}

/// Release algorithm-specific state, then wipe the inline AEAD context.
///
/// # Safety
///
/// `ctx` must point to a live, uniquely owned `EVP_AEAD_CTX`.
unsafe fn cleanup_and_cleanse(ctx: *mut bssl_sys::EVP_AEAD_CTX) {
    unsafe {
        bssl_sys::EVP_AEAD_CTX_cleanup(ctx);
        bssl_sys::OPENSSL_cleanse(ctx.cast(), core::mem::size_of::<bssl_sys::EVP_AEAD_CTX>());
    }
}

impl AeadCtx {
    /// Create a context for `kind`. The key must be exactly
    /// [`AeadKind::key_len`] bytes; wrong-length keys are rejected rather
    /// than truncated.
    pub(crate) fn new(kind: AeadKind, key: &[u8]) -> Result<Self, Error> {
        if key.len() != kind.key_len() {
            return Err(Error::General(format!(
                "boringssl {kind:?}: key of {} bytes, need {}",
                key.len(),
                kind.key_len(),
            )));
        }
        // SAFETY: `key` is exactly the required number of valid bytes.
        let ptr =
            unsafe { bssl_sys::EVP_AEAD_CTX_new(kind.evp(), key.as_ptr(), key.len(), TAG_LEN) };
        if ptr.is_null() {
            return Err(crate::general_error(
                "EVP_AEAD_CTX_new",
                openssl::error::ErrorStack::get(),
            ));
        }
        Ok(Self(ptr))
    }

    /// [`AeadCtx::new`] for the trait constructors that cannot return an
    /// error. rustls always derives keys of exactly `key_len()` bytes, so a
    /// failure here is a local programming error, not a peer-triggerable
    /// condition; the upstream `ring` provider panics in the same place.
    pub(crate) fn new_or_die(kind: AeadKind, key: &AeadKey) -> Self {
        Self::new(kind, key.as_ref()).expect("AEAD key of the wrong length for the suite")
    }

    /// Seal `payload` in place, returning the detached tag.
    pub(crate) fn seal_in_place_detached(
        &self,
        nonce: &Nonce,
        aad: &[u8],
        payload: &mut [u8],
    ) -> Result<[u8; TAG_LEN], Error> {
        let mut tag = [0u8; TAG_LEN];
        let mut tag_len = 0usize;
        let ptr = payload.as_mut_ptr();
        let error_queue = ErrorQueueGuard::new();
        // SAFETY: BoringSSL permits `out == in` aliasing exactly; the tag
        // buffer does not alias anything else.
        let rc = unsafe {
            bssl_sys::EVP_AEAD_CTX_seal_scatter(
                self.0,
                ptr,
                tag.as_mut_ptr(),
                &mut tag_len,
                tag.len(),
                nonce.0.as_ptr(),
                nonce.0.len(),
                ptr.cast_const(),
                payload.len(),
                core::ptr::null(),
                0,
                aad.as_ptr(),
                aad.len(),
            )
        };
        drop(error_queue);
        if rc != 1 || tag_len != TAG_LEN {
            return Err(Error::EncryptError);
        }
        Ok(tag)
    }

    /// Open `payload` in place against a detached `tag`. These are stream
    /// ciphers (CTR / ChaCha20): the plaintext length equals the ciphertext
    /// length.
    pub(crate) fn open_in_place_detached(
        &self,
        nonce: &Nonce,
        aad: &[u8],
        payload: &mut [u8],
        tag: &[u8],
    ) -> Result<(), Error> {
        let ptr = payload.as_mut_ptr();
        let error_queue = ErrorQueueGuard::new();
        // SAFETY: BoringSSL permits `out == in` aliasing exactly.
        let rc = unsafe {
            bssl_sys::EVP_AEAD_CTX_open_gather(
                self.0,
                ptr,
                nonce.0.as_ptr(),
                nonce.0.len(),
                ptr.cast_const(),
                payload.len(),
                tag.as_ptr(),
                tag.len(),
                aad.as_ptr(),
                aad.len(),
            )
        };
        drop(error_queue);
        if rc != 1 {
            return Err(Error::DecryptError);
        }
        Ok(())
    }
}

// MARK: TLS 1.3 record protection

pub(crate) struct Tls13Aead(AeadKind);

impl Tls13AeadAlgorithm for Tls13Aead {
    fn encrypter(&self, key: AeadKey, iv: Iv) -> Box<dyn MessageEncrypter> {
        Box::new(RecordCrypter {
            ctx: AeadCtx::new_or_die(self.0, &key),
            iv,
        })
    }

    fn decrypter(&self, key: AeadKey, iv: Iv) -> Box<dyn MessageDecrypter> {
        Box::new(RecordCrypter {
            ctx: AeadCtx::new_or_die(self.0, &key),
            iv,
        })
    }

    fn key_len(&self) -> usize {
        self.0.key_len()
    }

    fn extract_keys(
        &self,
        key: AeadKey,
        iv: Iv,
    ) -> Result<ConnectionTrafficSecrets, UnsupportedOperationError> {
        Ok(match self.0 {
            AeadKind::Aes128Gcm => ConnectionTrafficSecrets::Aes128Gcm { key, iv },
            AeadKind::Aes256Gcm => ConnectionTrafficSecrets::Aes256Gcm { key, iv },
            AeadKind::ChaCha20Poly1305 => ConnectionTrafficSecrets::Chacha20Poly1305 { key, iv },
        })
    }
}

struct RecordCrypter {
    ctx: AeadCtx,
    iv: Iv,
}

impl MessageEncrypter for RecordCrypter {
    fn encrypt(
        &mut self,
        msg: OutboundPlainMessage<'_>,
        seq: u64,
    ) -> Result<OutboundOpaqueMessage, Error> {
        let total_len = self.encrypted_payload_len(msg.payload.len());
        let aad = make_tls13_aad(total_len);
        let nonce = Nonce::new(&self.iv, seq);

        // TLSInnerPlaintext: content followed by the real content type,
        // encrypted in place inside the output buffer.
        let mut payload = PrefixedPayload::with_capacity(total_len);
        payload.extend_from_chunks(&msg.payload);
        payload.extend_from_slice(&[u8::from(msg.typ)]);

        let tag = self
            .ctx
            .seal_in_place_detached(&nonce, &aad, payload.as_mut())?;
        payload.extend_from_slice(&tag);

        // TLS 1.3 records are outwardly TLS 1.2 application data (RFC 8446 §5.1).
        Ok(OutboundOpaqueMessage::new(
            ContentType::ApplicationData,
            ProtocolVersion::TLSv1_2,
            payload,
        ))
    }

    fn encrypted_payload_len(&self, payload_len: usize) -> usize {
        payload_len + 1 + TAG_LEN
    }
}

impl MessageDecrypter for RecordCrypter {
    fn decrypt<'a>(
        &mut self,
        mut msg: InboundOpaqueMessage<'a>,
        seq: u64,
    ) -> Result<InboundPlainMessage<'a>, Error> {
        let payload = &mut msg.payload;
        if payload.len() < TAG_LEN {
            return Err(Error::DecryptError);
        }

        let aad = make_tls13_aad(payload.len());
        let nonce = Nonce::new(&self.iv, seq);
        let plain_len = payload.len() - TAG_LEN;
        let (ciphertext, tag) = payload.split_at_mut(plain_len);
        self.ctx
            .open_in_place_detached(&nonce, &aad, ciphertext, tag)?;

        payload.truncate(plain_len);
        msg.into_tls13_unpadded_message()
    }
}

#[cfg(test)]
mod tests {
    use std::mem::ManuallyDrop;

    use rustls::crypto::cipher::OutboundChunks;

    use super::*;
    use crate::testutil::{arr, hex};

    #[test]
    fn aead_ctx_rejects_wrong_key_lengths() {
        assert!(AeadCtx::new(AeadKind::Aes128Gcm, &[0u8; 32]).is_err());
        assert!(AeadCtx::new(AeadKind::Aes256Gcm, &[0u8; 16]).is_err());
        assert!(AeadCtx::new(AeadKind::ChaCha20Poly1305, &[0u8; 16]).is_err());
        assert!(AeadCtx::new(AeadKind::Aes128Gcm, &[0u8; 16]).is_ok());
    }

    #[test]
    fn aead_context_is_cleansed_before_free() {
        let ctx = ManuallyDrop::new(AeadCtx::new(AeadKind::Aes256Gcm, &[0xa5; 32]).unwrap());
        let ptr = ctx.0;

        // SAFETY: ManuallyDrop leaves this uniquely owned context live. After
        // checking the wipe, EVP_AEAD_CTX_free consumes it exactly once.
        unsafe {
            cleanup_and_cleanse(ptr);
            let bytes = core::slice::from_raw_parts(
                ptr.cast::<u8>(),
                core::mem::size_of::<bssl_sys::EVP_AEAD_CTX>(),
            );
            assert!(bytes.iter().all(|&byte| byte == 0));
            bssl_sys::EVP_AEAD_CTX_free(ptr);
        }
    }

    #[test]
    fn nist_aes_gcm_known_answer_vectors() {
        // NIST SP 800-38D, test case 2 for each key size: a single zero
        // plaintext block, a 96-bit zero IV, and no associated data.
        let nonce = Nonce([0u8; 12]);
        let cases = [
            (
                AeadKind::Aes128Gcm,
                &[0u8; 16][..],
                "0388dace60b6a392f328c2b971b2fe78",
                "ab6e47d42cec13bdf53a67b21257bddf",
            ),
            (
                AeadKind::Aes256Gcm,
                &[0u8; 32][..],
                "cea7403d4d606b6e074ec5d3baf39d18",
                "d0d1c8a799996bf0265b98b5d48ab919",
            ),
        ];

        for (kind, key, expected_ciphertext, expected_tag) in cases {
            let ctx = AeadCtx::new(kind, key).unwrap();
            let mut block = [0u8; 16];
            let tag = ctx.seal_in_place_detached(&nonce, &[], &mut block).unwrap();
            assert_eq!(block.as_slice(), hex(expected_ciphertext));
            assert_eq!(tag.as_slice(), hex(expected_tag));

            ctx.open_in_place_detached(&nonce, &[], &mut block, &tag)
                .unwrap();
            assert_eq!(block, [0u8; 16]);
        }
    }

    /// RFC 8439 §2.8.2: the ChaCha20-Poly1305 AEAD test vector.
    #[test]
    fn rfc8439_aead_vector() {
        let key = hex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
        let nonce = Nonce(arr::<12>(&hex("070000004041424344454647")));
        let aad = hex("50515253c0c1c2c3c4c5c6c7");
        let plain = b"Ladies and Gentlemen of the class of '99: \
                      If I could offer you only one tip for the future, \
                      sunscreen would be it.";
        let ciphertext = hex(
            "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6\
             3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36\
             92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc\
             3ff4def08e4b7a9de576d26586cec64b6116",
        );
        let tag = hex("1ae10b594f09e26a7e902ecbd0600691");

        let ctx = AeadCtx::new(AeadKind::ChaCha20Poly1305, &key).unwrap();
        let mut buf = plain.to_vec();
        let detached = ctx.seal_in_place_detached(&nonce, &aad, &mut buf).unwrap();
        assert_eq!(buf[..], ciphertext[..]);
        assert_eq!(detached[..], tag[..]);

        ctx.open_in_place_detached(&nonce, &aad, &mut buf, &detached)
            .unwrap();
        assert_eq!(buf, plain);

        // A bad tag must fail.
        let mut bad_tag = detached;
        bad_tag[TAG_LEN - 1] ^= 1;
        let mut sealed = ciphertext.clone();
        assert!(
            ctx.open_in_place_detached(&nonce, &aad, &mut sealed, &bad_tag)
                .is_err()
        );
        assert!(
            openssl::error::ErrorStack::get().errors().is_empty(),
            "AEAD authentication failure leaked into BoringSSL's error queue"
        );
    }

    #[test]
    fn authentication_failures_drain_error_queue_for_every_aead() {
        let nonce = Nonce([0x11; 12]);
        let aad = b"associated data";

        for (kind, key) in [
            (AeadKind::Aes128Gcm, &[0x22; 16][..]),
            (AeadKind::Aes256Gcm, &[0x33; 32][..]),
            (AeadKind::ChaCha20Poly1305, &[0x44; 32][..]),
        ] {
            // Isolate this assertion from any error a previous test left on
            // the current worker thread.
            drop(openssl::error::ErrorStack::get());

            let ctx = AeadCtx::new(kind, key).unwrap();
            let mut payload = b"plaintext".to_vec();
            let mut tag = ctx
                .seal_in_place_detached(&nonce, aad, &mut payload)
                .unwrap();
            tag[0] ^= 1;
            assert!(
                ctx.open_in_place_detached(&nonce, aad, &mut payload, &tag)
                    .is_err()
            );
            assert!(
                openssl::error::ErrorStack::get().errors().is_empty(),
                "{kind:?} left a stale error"
            );
        }
    }

    #[test]
    fn aead_error_scope_preserves_preexisting_diagnostics() {
        drop(openssl::error::ErrorStack::get());

        let nonce = Nonce([0x71; 12]);
        let ctx = AeadCtx::new(AeadKind::Aes256Gcm, &[0x72; 32]).unwrap();
        let mut payload = b"plaintext".to_vec();

        // Seed a sentinel directly because constructing an `ErrorStack`
        // would drain it. Both a successful raw call and a later
        // authentication failure must leave this older diagnostic intact.
        unsafe {
            bssl_sys::ERR_put_error(
                bssl_sys::ERR_LIB_USER as core::ffi::c_int,
                0,
                bssl_sys::ERR_R_INTERNAL_ERROR,
                b"rustls-boring AEAD test\0".as_ptr().cast(),
                line!(),
            );
        }
        let sentinel = unsafe { bssl_sys::ERR_peek_error() };
        assert_ne!(sentinel, 0);

        let mut tag = ctx
            .seal_in_place_detached(&nonce, b"aad", &mut payload)
            .unwrap();
        assert_eq!(unsafe { bssl_sys::ERR_peek_error() }, sentinel);

        tag[0] ^= 1;
        assert!(
            ctx.open_in_place_detached(&nonce, b"aad", &mut payload, &tag)
                .is_err()
        );
        assert_eq!(unsafe { bssl_sys::ERR_peek_error() }, sentinel);

        let errors = openssl::error::ErrorStack::get();
        assert_eq!(errors.errors().len(), 1);
        assert_eq!(errors.errors()[0].code(), sentinel);
    }

    #[test]
    fn open_failures_zero_plaintext_and_reject_wrong_tag_lengths() {
        let nonce = Nonce([0x51; 12]);
        let aad = b"authenticated header";

        for (kind, key) in [
            (AeadKind::Aes128Gcm, &[0x12; 16][..]),
            (AeadKind::Aes256Gcm, &[0x23; 32][..]),
            (AeadKind::ChaCha20Poly1305, &[0x34; 32][..]),
        ] {
            let ctx = AeadCtx::new(kind, key).unwrap();
            let plain = b"never return unauthenticated plaintext";
            let mut ciphertext = plain.to_vec();
            let tag = ctx
                .seal_in_place_detached(&nonce, aad, &mut ciphertext)
                .unwrap();

            let mut bad_tag = tag;
            bad_tag[0] ^= 0x80;
            let mut output = ciphertext.clone();
            assert!(
                ctx.open_in_place_detached(&nonce, aad, &mut output, &bad_tag)
                    .is_err()
            );
            assert!(output.iter().all(|&byte| byte == 0), "{kind:?}");

            let mut bad_ciphertext = ciphertext.clone();
            bad_ciphertext[0] ^= 0x80;
            assert!(
                ctx.open_in_place_detached(&nonce, aad, &mut bad_ciphertext, &tag)
                    .is_err()
            );
            assert!(bad_ciphertext.iter().all(|&byte| byte == 0), "{kind:?}");

            let mut wrong_aad = ciphertext.clone();
            assert!(
                ctx.open_in_place_detached(&nonce, b"wrong header", &mut wrong_aad, &tag)
                    .is_err()
            );
            assert!(wrong_aad.iter().all(|&byte| byte == 0), "{kind:?}");

            let mut long_tag = tag.to_vec();
            long_tag.push(0);
            for wrong_tag in [&tag[..0], &tag[..TAG_LEN - 1], long_tag.as_slice()] {
                let mut output = ciphertext.clone();
                assert!(
                    ctx.open_in_place_detached(&nonce, aad, &mut output, wrong_tag)
                        .is_err()
                );
                assert!(output.iter().all(|&byte| byte == 0), "{kind:?}");
            }
        }
    }

    #[test]
    fn empty_plaintext_and_aad_roundtrip_for_every_aead() {
        let nonce = Nonce([0u8; 12]);
        for (kind, key) in [
            (AeadKind::Aes128Gcm, &[0u8; 16][..]),
            (AeadKind::Aes256Gcm, &[0u8; 32][..]),
            (AeadKind::ChaCha20Poly1305, &[0u8; 32][..]),
        ] {
            let ctx = AeadCtx::new(kind, key).unwrap();
            let mut empty = [];
            let tag = ctx.seal_in_place_detached(&nonce, &[], &mut empty).unwrap();
            assert_ne!(tag, [0u8; TAG_LEN]);
            ctx.open_in_place_detached(&nonce, &[], &mut empty, &tag)
                .unwrap();
        }
    }

    /// Record roundtrip plus tamper/wrong-sequence rejection, for the suites
    /// whose keys are 32 bytes (the only length [`AeadKey`] can be built
    /// with publicly). AES-128-GCM records are exercised end-to-end via the
    /// forced-suite handshake in `handshake_test`.
    fn roundtrip(alg: &Tls13Aead) {
        let mut enc = alg.encrypter(AeadKey::from([0x42u8; 32]), Iv::from([0x24u8; 12]));
        let mut dec = alg.decrypter(AeadKey::from([0x42u8; 32]), Iv::from([0x24u8; 12]));

        let plain = b"hello from BoringSSL";
        let msg = OutboundPlainMessage {
            typ: ContentType::ApplicationData,
            version: ProtocolVersion::TLSv1_3,
            payload: OutboundChunks::Single(plain),
        };
        let sealed = enc.encrypt(msg, 7).unwrap();
        assert_eq!(sealed.payload.as_ref().len(), plain.len() + 1 + TAG_LEN);

        let mut wire = sealed.payload.as_ref().to_vec();
        let inbound = InboundOpaqueMessage::new(
            ContentType::ApplicationData,
            ProtocolVersion::TLSv1_2,
            &mut wire,
        );
        let opened = dec.decrypt(inbound, 7).unwrap();
        assert_eq!(opened.payload, plain);
        assert_eq!(opened.typ, ContentType::ApplicationData);

        // Same record at the wrong sequence number must fail.
        let mut wire = sealed.payload.as_ref().to_vec();
        let inbound = InboundOpaqueMessage::new(
            ContentType::ApplicationData,
            ProtocolVersion::TLSv1_2,
            &mut wire,
        );
        assert!(dec.decrypt(inbound, 8).is_err());

        // Corrupted ciphertext must fail.
        let mut wire = sealed.payload.as_ref().to_vec();
        wire[0] ^= 1;
        let inbound = InboundOpaqueMessage::new(
            ContentType::ApplicationData,
            ProtocolVersion::TLSv1_2,
            &mut wire,
        );
        assert!(dec.decrypt(inbound, 7).is_err());
    }

    #[test]
    fn record_roundtrip_and_tamper() {
        roundtrip(&AES_256_GCM);
        roundtrip(&CHACHA20_POLY1305);
    }
}
