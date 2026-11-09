// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Opus (third-party//by-name/op/opus, linked in): an encoder for this
//! process's microphone and a decoder for each voice it hears, mono at
//! 48 kHz, in frames of [`FRAME`] samples. libopus is called here alone.

use std::ffi::c_int;

/// Samples per second.
pub const RATE: i32 = 48_000;

/// Samples in a frame: 20 ms, the frame voice calls send.
pub const FRAME: usize = 960;

/// The most a frame's packet takes: Opus's own limit for a 20 ms frame
/// is far above what the bitrate below produces.
const MAX_PACKET: usize = 1500;

/// Bits per second for speech: wideband voice, with room for the
/// redundancy that in-band FEC adds.
const BITRATE: c_int = 32_000;

/// The loss the encoder plans its redundancy (in-band FEC) for, in percent.
const EXPECTED_LOSS: c_int = 5;

#[repr(C)]
struct OpusEncoder {
    _private: [u8; 0],
}

#[repr(C)]
struct OpusDecoder {
    _private: [u8; 0],
}

const OPUS_OK: c_int = 0;
const OPUS_APPLICATION_VOIP: c_int = 2048;
const OPUS_SET_BITRATE_REQUEST: c_int = 4002;
const OPUS_SET_INBAND_FEC_REQUEST: c_int = 4012;
const OPUS_SET_PACKET_LOSS_PERC_REQUEST: c_int = 4014;
const OPUS_SET_DTX_REQUEST: c_int = 4016;
const OPUS_SET_SIGNAL_REQUEST: c_int = 4024;
const OPUS_SIGNAL_VOICE: c_int = 3001;

unsafe extern "C" {
    fn opus_encoder_create(
        fs: i32,
        channels: c_int,
        application: c_int,
        error: *mut c_int,
    ) -> *mut OpusEncoder;
    fn opus_encode(
        st: *mut OpusEncoder,
        pcm: *const i16,
        frame_size: c_int,
        data: *mut u8,
        max: i32,
    ) -> i32;
    fn opus_encoder_ctl(st: *mut OpusEncoder, request: c_int, ...) -> c_int;
    fn opus_encoder_destroy(st: *mut OpusEncoder);
    fn opus_decoder_create(fs: i32, channels: c_int, error: *mut c_int) -> *mut OpusDecoder;
    fn opus_decode(
        st: *mut OpusDecoder,
        data: *const u8,
        len: i32,
        pcm: *mut i16,
        frame_size: c_int,
        decode_fec: c_int,
    ) -> c_int;
    fn opus_decoder_destroy(st: *mut OpusDecoder);
}

/// Encodes this process's microphone, a frame at a time.
pub struct Encoder {
    st: *mut OpusEncoder,
}

// SAFETY: an encoder's state is used by one thread at a time (&mut self);
// libopus keeps no state outside it.
unsafe impl Send for Encoder {}

impl Encoder {
    pub fn new() -> Result<Encoder, String> {
        let mut error = 0;
        // SAFETY: creating an encoder only writes `error`.
        let st = unsafe { opus_encoder_create(RATE, 1, OPUS_APPLICATION_VOIP, &mut error) };
        if st.is_null() || error != OPUS_OK {
            return Err(format!("opus: no encoder (error {error})"));
        }
        let encoder = Encoder { st };
        // Speech, with redundancy against loss, and nothing sent in silence.
        for (request, value) in [
            (OPUS_SET_SIGNAL_REQUEST, OPUS_SIGNAL_VOICE),
            (OPUS_SET_BITRATE_REQUEST, BITRATE),
            (OPUS_SET_INBAND_FEC_REQUEST, 1),
            (OPUS_SET_PACKET_LOSS_PERC_REQUEST, EXPECTED_LOSS),
            (OPUS_SET_DTX_REQUEST, 1),
        ] {
            // SAFETY: each of these requests takes one opus_int32.
            if unsafe { opus_encoder_ctl(encoder.st, request, value) } != OPUS_OK {
                return Err(format!("opus: the encoder refused setting {request}"));
            }
        }
        Ok(encoder)
    }

    /// The packet for a frame, or None when it need not be sent: in
    /// silence (discontinuous transmission), the encoder makes a packet of
    /// a byte or two that a decoder does as well without.
    pub fn encode(&mut self, frame: &[i16; FRAME]) -> Result<Option<Vec<u8>>, String> {
        let mut packet = vec![0u8; MAX_PACKET];
        // SAFETY: `frame` holds FRAME samples, and `packet` MAX_PACKET bytes.
        let n = unsafe {
            opus_encode(
                self.st,
                frame.as_ptr(),
                FRAME as c_int,
                packet.as_mut_ptr(),
                MAX_PACKET as i32,
            )
        };
        if n < 0 {
            return Err(format!("opus: encoding failed (error {n})"));
        }
        if n <= 2 {
            return Ok(None);
        }
        packet.truncate(n as usize);
        Ok(Some(packet))
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        // SAFETY: made by opus_encoder_create, and destroyed once.
        unsafe { opus_encoder_destroy(self.st) }
    }
}

/// Decodes one voice: one speaker's packets, in order.
pub struct Decoder {
    st: *mut OpusDecoder,
}

// SAFETY: as for Encoder.
unsafe impl Send for Decoder {}

/// What a decoder makes a frame from.
pub enum Input<'a> {
    /// The frame's own packet.
    Packet(&'a [u8]),
    /// The frame was lost, but the next one's packet arrived: its
    /// redundancy (in-band FEC) has a coarser copy of this one.
    Recovered(&'a [u8]),
    /// The frame was lost: the decoder makes up what it can (packet loss
    /// concealment).
    Lost,
}

impl Decoder {
    pub fn new() -> Result<Decoder, String> {
        let mut error = 0;
        // SAFETY: creating a decoder only writes `error`.
        let st = unsafe { opus_decoder_create(RATE, 1, &mut error) };
        if st.is_null() || error != OPUS_OK {
            return Err(format!("opus: no decoder (error {error})"));
        }
        Ok(Decoder { st })
    }

    /// A frame's samples, from `input`; silence where the packet is bad.
    pub fn decode(&mut self, input: Input, frame: &mut [i16; FRAME]) {
        let (data, fec) = match input {
            Input::Packet(p) => (p, 0),
            Input::Recovered(p) => (p, 1),
            Input::Lost => (&[][..], 0),
        };
        let ptr = if data.is_empty() {
            std::ptr::null()
        } else {
            data.as_ptr()
        };
        // SAFETY: `data` is `len` bytes (none, for concealment: a null
        // pointer), and `frame` holds FRAME samples.
        let n = unsafe {
            opus_decode(
                self.st,
                ptr,
                data.len() as i32,
                frame.as_mut_ptr(),
                FRAME as c_int,
                fec,
            )
        };
        if n != FRAME as c_int {
            frame.fill(0);
        }
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        // SAFETY: made by opus_decoder_create, and destroyed once.
        unsafe { opus_decoder_destroy(self.st) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tone at `hz`, for `frames` frames.
    pub fn tone(hz: f64, frames: usize) -> Vec<[i16; FRAME]> {
        (0..frames)
            .map(|f| {
                std::array::from_fn(|i| {
                    let t = (f * FRAME + i) as f64 / RATE as f64;
                    (8000.0 * (2.0 * std::f64::consts::PI * hz * t).sin()) as i16
                })
            })
            .collect()
    }

    #[test]
    fn speech_goes_through_and_silence_is_not_sent() {
        let mut encoder = Encoder::new().unwrap();
        let mut decoder = Decoder::new().unwrap();
        let mut out = [0i16; FRAME];
        let mut energy = 0.0;
        for frame in tone(440.0, 25) {
            let packet = encoder.encode(&frame).unwrap().expect("a tone is sent");
            decoder.decode(Input::Packet(&packet), &mut out);
            energy = out.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / FRAME as f64;
        }
        assert!(energy.sqrt() > 2000.0, "rms {}", energy.sqrt());
        // Once the encoder has heard enough silence, it stops sending.
        let sent = (0..50)
            .filter(|_| encoder.encode(&[0; FRAME]).unwrap().is_some())
            .count();
        assert!(sent < 25, "{sent} of 50 silent frames sent");
        decoder.decode(Input::Lost, &mut out);
    }
}
