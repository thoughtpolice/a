// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! QUIC packet protection (RFC 9001) for every suite: in-place AEAD payload
//! sealing via the shared [`AeadCtx`], plus AES-ECB and ChaCha20 header
//! protection masks.

use rustls::Error;
use rustls::crypto::cipher::{AeadKey, Iv, Nonce};
use rustls::quic;

use crate::aead::{AeadCtx, AeadKind, TAG_LEN};

pub(crate) const SAMPLE_LEN: usize = 16;

pub(crate) static AES_128_GCM: QuicAead = QuicAead(AeadKind::Aes128Gcm);
pub(crate) static AES_256_GCM: QuicAead = QuicAead(AeadKind::Aes256Gcm);
pub(crate) static CHACHA20_POLY1305: QuicAead = QuicAead(AeadKind::ChaCha20Poly1305);

/// AEAD usage limits from RFC 9001 §6.6. The ChaCha20-Poly1305
/// confidentiality limit exceeds the number of possible packets (2^62) and
/// so can be disregarded.
fn confidentiality_limit(kind: AeadKind) -> u64 {
    match kind {
        AeadKind::Aes128Gcm | AeadKind::Aes256Gcm => 1 << 23,
        AeadKind::ChaCha20Poly1305 => u64::MAX,
    }
}

fn integrity_limit(kind: AeadKind) -> u64 {
    match kind {
        AeadKind::Aes128Gcm | AeadKind::Aes256Gcm => 1 << 52,
        AeadKind::ChaCha20Poly1305 => 1 << 36,
    }
}

pub(crate) struct QuicAead(AeadKind);

impl quic::Algorithm for QuicAead {
    fn packet_key(&self, key: AeadKey, iv: Iv) -> Box<dyn quic::PacketKey> {
        Box::new(PacketKey {
            ctx: AeadCtx::new_or_die(self.0, &key),
            iv,
            kind: self.0,
        })
    }

    fn header_protection_key(&self, key: AeadKey) -> Box<dyn quic::HeaderProtectionKey> {
        match self.0 {
            AeadKind::Aes128Gcm | AeadKind::Aes256Gcm => Box::new(AesHeaderKey::new(self.0, &key)),
            AeadKind::ChaCha20Poly1305 => Box::new(ChaChaHeaderKey::new(&key)),
        }
    }

    fn aead_key_len(&self) -> usize {
        self.0.key_len()
    }
}

struct PacketKey {
    ctx: AeadCtx,
    iv: Iv,
    kind: AeadKind,
}

impl PacketKey {
    fn seal(&self, nonce: Nonce, header: &[u8], payload: &mut [u8]) -> Result<quic::Tag, Error> {
        let tag = self.ctx.seal_in_place_detached(&nonce, header, payload)?;
        Ok(quic::Tag::from(&tag[..]))
    }

    fn open<'a>(
        &self,
        nonce: Nonce,
        header: &[u8],
        payload: &'a mut [u8],
    ) -> Result<&'a [u8], Error> {
        if payload.len() < TAG_LEN {
            return Err(Error::DecryptError);
        }
        let plain_len = payload.len() - TAG_LEN;
        let (ciphertext, tag) = payload.split_at_mut(plain_len);
        self.ctx
            .open_in_place_detached(&nonce, header, ciphertext, tag)?;
        Ok(&payload[..plain_len])
    }
}

impl quic::PacketKey for PacketKey {
    fn encrypt_in_place(
        &self,
        packet_number: u64,
        header: &[u8],
        payload: &mut [u8],
    ) -> Result<quic::Tag, Error> {
        self.seal(Nonce::new(&self.iv, packet_number), header, payload)
    }

    fn encrypt_in_place_for_path(
        &self,
        path_id: u32,
        packet_number: u64,
        header: &[u8],
        payload: &mut [u8],
    ) -> Result<quic::Tag, Error> {
        self.seal(
            Nonce::for_path(path_id, &self.iv, packet_number),
            header,
            payload,
        )
    }

    fn decrypt_in_place<'a>(
        &self,
        packet_number: u64,
        header: &[u8],
        payload: &'a mut [u8],
    ) -> Result<&'a [u8], Error> {
        self.open(Nonce::new(&self.iv, packet_number), header, payload)
    }

    fn decrypt_in_place_for_path<'a>(
        &self,
        path_id: u32,
        packet_number: u64,
        header: &[u8],
        payload: &'a mut [u8],
    ) -> Result<&'a [u8], Error> {
        self.open(
            Nonce::for_path(path_id, &self.iv, packet_number),
            header,
            payload,
        )
    }

    fn tag_len(&self) -> usize {
        TAG_LEN
    }

    fn confidentiality_limit(&self) -> u64 {
        confidentiality_limit(self.kind)
    }

    fn integrity_limit(&self) -> u64 {
        integrity_limit(self.kind)
    }
}

// MARK: header protection

/// AES-ECB header protection (RFC 9001 §5.4.3): the mask is the first five
/// bytes of the block cipher applied to the sample.
///
/// The key schedule runs once here, and `AES_encrypt` is constant-time in
/// BoringSSL on every code path (AES-NI, VPAES, or the bitsliced fallback).
/// The schedule is boxed so it occupies a single stable heap address from
/// expansion to `Drop`'s cleanse: `AES_KEY` is `Copy`, and expanding it in
/// a stack local would strand copies behind the return-by-value that no
/// cleanse could reach.
struct AesHeaderKey(Box<bssl_sys::AES_KEY>);

impl AesHeaderKey {
    fn new(kind: AeadKind, key: &AeadKey) -> Self {
        let key = key.as_ref();
        // Wrong-length keys are a local programming error; see
        // `AeadCtx::new_or_die`.
        assert_eq!(
            key.len(),
            kind.key_len(),
            "header protection key of the wrong length for the suite"
        );
        let mut aes = Box::new(bssl_sys::AES_KEY {
            rd_key: [0u32; 60],
            rounds: 0,
        });
        // SAFETY: `key` is exactly `bits / 8` valid bytes, and the out
        // pointer denotes the boxed struct we uniquely own.
        let rc = unsafe {
            bssl_sys::AES_set_encrypt_key(
                key.as_ptr(),
                (key.len() * 8) as core::ffi::c_uint,
                &mut *aes,
            )
        };
        assert_eq!(rc, 0, "AES_set_encrypt_key rejected a 128/256-bit key");
        Self(aes)
    }

    fn mask(&self, sample: &[u8]) -> Result<[u8; 5], Error> {
        if sample.len() != SAMPLE_LEN {
            return Err(Error::General(
                "QUIC header sample of invalid length".into(),
            ));
        }
        let mut block = [0u8; 16];
        // SAFETY: in/out are 16-byte blocks and the key was expanded in `new`.
        unsafe { bssl_sys::AES_encrypt(sample.as_ptr(), block.as_mut_ptr(), &*self.0) };
        Ok(block[..5].try_into().expect("mask is 5 bytes"))
    }
}

impl Drop for AesHeaderKey {
    fn drop(&mut self) {
        cleanse_aes_key(&mut *self.0);
    }
}

fn cleanse_aes_key(key: &mut bssl_sys::AES_KEY) {
    // SAFETY: the pointer/length denote exactly the struct we own; AES_KEY
    // is plain old data.
    unsafe {
        bssl_sys::OPENSSL_cleanse(
            core::ptr::from_mut(key).cast(),
            core::mem::size_of::<bssl_sys::AES_KEY>(),
        );
    }
}

/// ChaCha20 header protection (RFC 9001 §5.4.4): the mask is the first five
/// bytes of a ChaCha20 block keyed with the header protection key, taking
/// the block counter from the first four sample bytes and the nonce from
/// the remaining twelve.
/// Keep the raw key in a stable allocation for the same reason that
/// [`AesHeaderKey`] boxes its expanded schedule: constructing an inline array
/// and returning it by value can strand an optimizer-created stack copy which
/// `Drop` cannot reach.
struct ChaChaHeaderKey(Box<[u8; 32]>);

impl ChaChaHeaderKey {
    fn new(key: &AeadKey) -> Self {
        // Wrong-length keys are a local programming error; see
        // `AeadCtx::new_or_die`.
        assert_eq!(
            key.as_ref().len(),
            32,
            "header protection key of the wrong length for the suite"
        );
        let mut stable_key = Box::new([0u8; 32]);
        stable_key.copy_from_slice(key.as_ref());
        Self(stable_key)
    }

    fn mask(&self, sample: &[u8]) -> Result<[u8; 5], Error> {
        if sample.len() != SAMPLE_LEN {
            return Err(Error::General(
                "QUIC header sample of invalid length".into(),
            ));
        }
        let counter = u32::from_le_bytes(sample[..4].try_into().expect("4 sample bytes"));
        let zeros = [0u8; 5];
        let mut mask = [0u8; 5];
        // SAFETY: out/in are 5 bytes, the key is 32 bytes, and the nonce is
        // the remaining 12 sample bytes, as CRYPTO_chacha_20 requires.
        unsafe {
            bssl_sys::CRYPTO_chacha_20(
                mask.as_mut_ptr(),
                zeros.as_ptr(),
                zeros.len(),
                self.0.as_ptr(),
                sample[4..].as_ptr(),
                counter,
            );
        }
        Ok(mask)
    }
}

impl Drop for ChaChaHeaderKey {
    fn drop(&mut self) {
        crate::cleanse(&mut self.0[..]);
    }
}

/// RFC 9001 §5.4.1 "Header Protection Application".
fn xor_header_in_place(
    mask: &[u8; 5],
    first: &mut u8,
    packet_number: &mut [u8],
    masked: bool,
) -> Result<(), Error> {
    let (first_mask, pn_mask) = mask.split_first().expect("mask is non-empty");

    if packet_number.len() > pn_mask.len() {
        return Err(Error::General("packet number too long".into()));
    }

    // Long headers mask 4 low bits of the first byte, short headers 5.
    const LONG_HEADER_FORM: u8 = 0x80;
    let bits = if *first & LONG_HEADER_FORM == LONG_HEADER_FORM {
        0x0f
    } else {
        0x1f
    };

    // The packet number length bits are read from the unprotected byte.
    let first_plain = if masked {
        *first ^ (first_mask & bits)
    } else {
        *first
    };
    let pn_len = (first_plain & 0x03) as usize + 1;
    if packet_number.len() < pn_len {
        return Err(Error::General("packet number too short".into()));
    }

    *first ^= first_mask & bits;
    for (dst, m) in packet_number.iter_mut().zip(pn_mask).take(pn_len) {
        *dst ^= m;
    }
    Ok(())
}

impl quic::HeaderProtectionKey for AesHeaderKey {
    fn encrypt_in_place(
        &self,
        sample: &[u8],
        first: &mut u8,
        packet_number: &mut [u8],
    ) -> Result<(), Error> {
        xor_header_in_place(&self.mask(sample)?, first, packet_number, false)
    }

    fn decrypt_in_place(
        &self,
        sample: &[u8],
        first: &mut u8,
        packet_number: &mut [u8],
    ) -> Result<(), Error> {
        xor_header_in_place(&self.mask(sample)?, first, packet_number, true)
    }

    fn sample_len(&self) -> usize {
        SAMPLE_LEN
    }
}

impl quic::HeaderProtectionKey for ChaChaHeaderKey {
    fn encrypt_in_place(
        &self,
        sample: &[u8],
        first: &mut u8,
        packet_number: &mut [u8],
    ) -> Result<(), Error> {
        xor_header_in_place(&self.mask(sample)?, first, packet_number, false)
    }

    fn decrypt_in_place(
        &self,
        sample: &[u8],
        first: &mut u8,
        packet_number: &mut [u8],
    ) -> Result<(), Error> {
        xor_header_in_place(&self.mask(sample)?, first, packet_number, true)
    }

    fn sample_len(&self) -> usize {
        SAMPLE_LEN
    }
}

#[cfg(test)]
mod tests {
    use std::mem::ManuallyDrop;

    use rustls::Side;
    use rustls::quic::{Algorithm as _, Keys, PacketKey as _, Version};

    use super::*;
    use crate::suites;
    use crate::testutil::{arr, hex};

    fn rfc9001_initial_keys(side: Side) -> Keys {
        // RFC 9001 appendix A: Destination Connection ID 0x8394c8f03e515708.
        let cid = [0x83, 0x94, 0xc8, 0xf0, 0x3e, 0x51, 0x57, 0x08];
        Keys::initial(
            Version::V1,
            suites::TLS13_AES_128_GCM_SHA256
                .tls13()
                .expect("tls13 suite"),
            &AES_128_GCM,
            &cid,
            side,
        )
    }

    /// RFC 9001 appendix A.2: protect the client Initial, then flip sides
    /// and unprotect it again. This exercises AES-128-GCM packet keys and
    /// AES header protection with genuinely derived (16-byte) keys, in both
    /// directions.
    #[test]
    fn rfc9001_a2_client_initial_protect_and_unprotect() {
        let client = rfc9001_initial_keys(Side::Client);

        // Unprotected header, packet number 2 (4-byte encoding).
        let header = hex("c300000001088394c8f03e5157080000449e00000002");
        // CRYPTO frame with the ClientHello, padded to 1162 bytes.
        let mut payload = hex(
            "060040f1010000ed0303ebf8fa56f12939b9584a3896472ec40bb863cfd3e868\
             04fe3a47f06a2b69484c00000413011302010000c000000010000e00000b6578\
             616d706c652e636f6dff01000100000a00080006001d00170018001000070005\
             04616c706e000500050100000000003300260024001d00209370b2c9caa47fba\
             baf4559fedba753de171fa71f50f1ce15d43e994ec74d748002b000302030400\
             0d0010000e0403050306030203080408050806002d00020101001c0002400100\
             3900320408ffffffffffffffff05048000ffff07048000ffff08011001048000\
             75300901100f088394c8f03e51570806048000ffff",
        );
        payload.resize(1162, 0);
        let plaintext = payload.clone();

        let tag = client
            .local
            .packet
            .encrypt_in_place(2, &header, &mut payload)
            .unwrap();

        // The first 16 bytes of ciphertext are the header protection sample
        // given in the RFC.
        assert_eq!(payload[..16], hex("d1b1c98dd7689fb8ec11d242b123dc9b")[..]);
        assert_eq!(tag.as_ref(), &hex("e221af44860018ab0856972e194cd934")[..]);

        // Apply header protection and check against the protected packet.
        let sample = payload[..16].to_vec();
        let mut protected = header.clone();
        {
            let (first, rest) = protected.split_at_mut(1);
            client
                .local
                .header
                .encrypt_in_place(&sample, &mut first[0], &mut rest[17..21])
                .unwrap();
        }
        assert_eq!(
            protected[..],
            hex("c000000001088394c8f03e5157080000449e7b9aec34")[..]
        );

        // The server's receive direction must round it all back.
        let server = rfc9001_initial_keys(Side::Server);
        {
            let (first, rest) = protected.split_at_mut(1);
            server
                .remote
                .header
                .decrypt_in_place(&sample, &mut first[0], &mut rest[17..21])
                .unwrap();
        }
        assert_eq!(protected, header);

        payload.extend_from_slice(tag.as_ref());
        let opened = server
            .remote
            .packet
            .decrypt_in_place(2, &header, &mut payload)
            .unwrap();
        assert_eq!(opened, plaintext);
    }

    /// RFC 9001 appendix A.5: ChaCha20-Poly1305 short header packet.
    #[test]
    fn rfc9001_a5_chacha_short_header_packet() {
        let key = AeadKey::from(arr::<32>(&hex(
            "c6d98ff3441c3fe1b2182094f69caa2ed4b716b65488960a7a984979fb23e1c8",
        )));
        let iv = Iv::from(arr::<12>(&hex("e0459b3474bdd0e44a41c144")));
        let hp = AeadKey::from(arr::<32>(&hex(
            "25a282b9e82f06f21f488917a4fc8f1b73573685608597d0efcb076b0ab7a7a4",
        )));
        const PN: u64 = 654_360_564;

        let pk = CHACHA20_POLY1305.packet_key(key, iv);
        let header = hex("4200bff4");
        let mut payload = vec![0x01];
        let tag = pk.encrypt_in_place(PN, &header, &mut payload).unwrap();
        payload.extend_from_slice(tag.as_ref());
        assert_eq!(payload[..], hex("655e5cd55c41f69080575d7999c25a5bfb")[..]);

        // One byte is skipped to produce the header protection sample.
        let hp = CHACHA20_POLY1305.header_protection_key(hp);
        let sample = payload[1..1 + SAMPLE_LEN].to_vec();
        assert_eq!(sample, hex("5e5cd55c41f69080575d7999c25a5bfb"));

        let mut protected = header.clone();
        let (first, pn_bytes) = protected.split_first_mut().unwrap();
        hp.encrypt_in_place(&sample, first, pn_bytes).unwrap();
        assert_eq!(protected, hex("4cfe4189"));

        // Round back: header unprotection, then packet decryption.
        let (first, pn_bytes) = protected.split_first_mut().unwrap();
        hp.decrypt_in_place(&sample, first, pn_bytes).unwrap();
        assert_eq!(protected, header);
        let opened = pk.decrypt_in_place(PN, &header, &mut payload).unwrap();
        assert_eq!(opened, [0x01]);
    }

    /// Packet roundtrips, including the multipath nonce variants, for the
    /// suites whose keys are 32 bytes (the only length [`AeadKey`] can be
    /// built with publicly). AES-128-GCM packets are covered by the A.2
    /// vector above with genuinely derived keys.
    #[test]
    fn packet_roundtrip_including_multipath() {
        for alg in [&AES_256_GCM, &CHACHA20_POLY1305] {
            let pk = alg.packet_key(AeadKey::from([7u8; 32]), Iv::from([9u8; 12]));

            let header = b"quic header";
            let plain = b"payload bytes";

            let mut buf = plain.to_vec();
            let tag = pk.encrypt_in_place(42, header, &mut buf).unwrap();
            buf.extend_from_slice(tag.as_ref());
            let out = pk.decrypt_in_place(42, header, &mut buf).unwrap();
            assert_eq!(out, plain);

            let mut buf = plain.to_vec();
            let tag = pk
                .encrypt_in_place_for_path(3, 42, header, &mut buf)
                .unwrap();
            buf.extend_from_slice(tag.as_ref());
            // Multipath nonces must differ from the single-path construction.
            assert!(pk.decrypt_in_place(42, header, &mut buf.clone()).is_err());
            let out = pk
                .decrypt_in_place_for_path(3, 42, header, &mut buf)
                .unwrap();
            assert_eq!(out, plain);
        }
    }

    #[test]
    fn packet_authentication_failures_zero_output() {
        for (kind, key) in [
            (AeadKind::Aes128Gcm, &[0x11; 16][..]),
            (AeadKind::Aes256Gcm, &[0x22; 32][..]),
            (AeadKind::ChaCha20Poly1305, &[0x33; 32][..]),
        ] {
            let pk = PacketKey {
                ctx: AeadCtx::new(kind, key).unwrap(),
                iv: Iv::from([0x44; 12]),
                kind,
            };
            let header = b"authenticated QUIC header";
            let plain = b"authenticated QUIC payload";
            let mut ciphertext = plain.to_vec();
            let tag = pk.encrypt_in_place(73, header, &mut ciphertext).unwrap();
            let mut sealed = ciphertext.clone();
            sealed.extend_from_slice(tag.as_ref());

            for mut rejected in [
                {
                    let mut value = sealed.clone();
                    value[0] ^= 1;
                    value
                },
                {
                    let mut value = sealed.clone();
                    *value.last_mut().unwrap() ^= 1;
                    value
                },
            ] {
                assert!(pk.decrypt_in_place(73, header, &mut rejected).is_err());
                assert!(rejected[..plain.len()].iter().all(|&byte| byte == 0));
            }

            let mut wrong_header = sealed.clone();
            assert!(
                pk.decrypt_in_place(73, b"different header", &mut wrong_header)
                    .is_err()
            );
            assert!(wrong_header[..plain.len()].iter().all(|&byte| byte == 0));

            let mut wrong_packet_number = sealed.clone();
            assert!(
                pk.decrypt_in_place(74, header, &mut wrong_packet_number)
                    .is_err()
            );
            assert!(
                wrong_packet_number[..plain.len()]
                    .iter()
                    .all(|&byte| byte == 0)
            );

            let mut wrong_path = sealed.clone();
            assert!(
                pk.decrypt_in_place_for_path(9, 73, header, &mut wrong_path)
                    .is_err()
            );
            assert!(wrong_path[..plain.len()].iter().all(|&byte| byte == 0));

            for len in 0..TAG_LEN {
                let mut short = vec![0xa5; len];
                assert!(pk.decrypt_in_place(73, header, &mut short).is_err());
                assert_eq!(short, vec![0xa5; len]);
            }

            let mut empty = Vec::new();
            let tag = pk.encrypt_in_place(75, &[], &mut empty).unwrap();
            empty.extend_from_slice(tag.as_ref());
            assert!(pk.decrypt_in_place(75, &[], &mut empty).unwrap().is_empty());
        }
    }

    #[test]
    fn header_protection_roundtrips_every_packet_number_length() {
        for hp in [
            AES_256_GCM.header_protection_key(AeadKey::from([0x55; 32])),
            CHACHA20_POLY1305.header_protection_key(AeadKey::from([0x66; 32])),
        ] {
            let sample = [0x77; SAMPLE_LEN];
            for long_header in [false, true] {
                for pn_len in 1..=4 {
                    let mut first = if long_header { 0xc0 } else { 0x40 } | (pn_len as u8 - 1);
                    let mut packet_number = vec![0x80, 0x81, 0x82, 0x83][..pn_len].to_vec();
                    let plain_first = first;
                    let plain_packet_number = packet_number.clone();
                    hp.encrypt_in_place(&sample, &mut first, &mut packet_number)
                        .unwrap();
                    hp.decrypt_in_place(&sample, &mut first, &mut packet_number)
                        .unwrap();
                    assert_eq!(first, plain_first);
                    assert_eq!(packet_number, plain_packet_number);
                }
            }
        }
    }

    #[test]
    fn header_protection_rejects_bad_buffer_lengths_without_mutation() {
        for hp in [
            AES_256_GCM.header_protection_key(AeadKey::from([0x88; 32])),
            CHACHA20_POLY1305.header_protection_key(AeadKey::from([0x99; 32])),
        ] {
            for sample in [&[0u8; SAMPLE_LEN - 1][..], &[0u8; SAMPLE_LEN + 1][..]] {
                let mut first = 0x40;
                let mut packet_number = [1u8];
                assert!(
                    hp.encrypt_in_place(sample, &mut first, &mut packet_number)
                        .is_err()
                );
                assert_eq!(first, 0x40);
                assert_eq!(packet_number, [1]);
            }

            let sample = [0u8; SAMPLE_LEN];
            let mut first = 0x40;
            let mut too_long = [1u8; 5];
            assert!(
                hp.encrypt_in_place(&sample, &mut first, &mut too_long)
                    .is_err()
            );
            assert_eq!(first, 0x40);
            assert_eq!(too_long, [1; 5]);

            // The low two bits request a four-byte packet number, but the
            // caller supplied only three. This must fail atomically.
            let mut first = 0x43;
            let mut too_short = [1u8; 3];
            assert!(
                hp.encrypt_in_place(&sample, &mut first, &mut too_short)
                    .is_err()
            );
            assert_eq!(first, 0x43);
            assert_eq!(too_short, [1; 3]);

            let mut first = 0x43;
            let mut packet_number = [1u8; 4];
            hp.encrypt_in_place(&sample, &mut first, &mut packet_number)
                .unwrap();
            let protected_first = first;
            let protected_prefix = packet_number[..3].to_vec();
            assert!(
                hp.decrypt_in_place(&sample, &mut first, &mut packet_number[..3])
                    .is_err()
            );
            assert_eq!(first, protected_first);
            assert_eq!(&packet_number[..3], protected_prefix);
        }
    }

    #[test]
    fn aes256_header_protection_known_answer() {
        // FIPS 197 appendix C.3: AES-256(K, P). QUIC takes the first five
        // bytes of the encrypted sample as its header mask.
        let key = AeadKey::from(arr::<32>(&hex(
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        )));
        let hp = AesHeaderKey::new(AeadKind::Aes256Gcm, &key);
        assert_eq!(
            hp.mask(&hex("00112233445566778899aabbccddeeff")).unwrap(),
            arr::<5>(&hex("8ea2b7ca51"))
        );
    }

    #[test]
    fn header_key_material_is_cleansed_before_free() {
        let mut aes = ManuallyDrop::new(AesHeaderKey::new(
            AeadKind::Aes256Gcm,
            &AeadKey::from([0xa5; 32]),
        ));
        cleanse_aes_key(&mut aes.0);
        let aes_bytes = unsafe {
            core::slice::from_raw_parts(
                core::ptr::from_ref(&*aes.0).cast::<u8>(),
                core::mem::size_of::<bssl_sys::AES_KEY>(),
            )
        };
        assert!(aes_bytes.iter().all(|&byte| byte == 0));
        drop(ManuallyDrop::into_inner(aes));

        let mut chacha = ManuallyDrop::new(ChaChaHeaderKey::new(&AeadKey::from([0xa5; 32])));
        crate::cleanse(&mut chacha.0[..]);
        assert!(chacha.0.iter().all(|&byte| byte == 0));
        drop(ManuallyDrop::into_inner(chacha));
    }

    #[test]
    fn quic_usage_limits_match_rfc9001() {
        assert_eq!(confidentiality_limit(AeadKind::Aes128Gcm), 1 << 23);
        assert_eq!(confidentiality_limit(AeadKind::Aes256Gcm), 1 << 23);
        assert_eq!(confidentiality_limit(AeadKind::ChaCha20Poly1305), u64::MAX);
        assert_eq!(integrity_limit(AeadKind::Aes128Gcm), 1 << 52);
        assert_eq!(integrity_limit(AeadKind::Aes256Gcm), 1 << 52);
        assert_eq!(integrity_limit(AeadKind::ChaCha20Poly1305), 1 << 36);
    }
}
