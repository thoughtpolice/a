# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

# The source lists follow celt_sources.mk, silk_sources.mk and
# opus_sources.mk: the floating-point build, in portable C. The SIMD
# variants (x86 SSE to AVX2, ARM NEON) and the neural-network extensions
# (deep PLC, DRED, OSCE: dnn/, which needs model data the release tarball
# downloads separately) are left out; a voice call's encoder and decoder
# take a fraction of a percent of a core without them.

CELT_SOURCES = [
    "celt/bands.c",
    "celt/celt.c",
    "celt/celt_encoder.c",
    "celt/celt_decoder.c",
    "celt/cwrs.c",
    "celt/entcode.c",
    "celt/entdec.c",
    "celt/entenc.c",
    "celt/kiss_fft.c",
    "celt/laplace.c",
    "celt/mathops.c",
    "celt/mdct.c",
    "celt/modes.c",
    "celt/pitch.c",
    "celt/celt_lpc.c",
    "celt/quant_bands.c",
    "celt/rate.c",
    "celt/vq.c",
]

SILK_SOURCES = [
    "silk/CNG.c",
    "silk/code_signs.c",
    "silk/init_decoder.c",
    "silk/decode_core.c",
    "silk/decode_frame.c",
    "silk/decode_parameters.c",
    "silk/decode_indices.c",
    "silk/decode_pulses.c",
    "silk/decoder_set_fs.c",
    "silk/dec_API.c",
    "silk/enc_API.c",
    "silk/encode_indices.c",
    "silk/encode_pulses.c",
    "silk/gain_quant.c",
    "silk/interpolate.c",
    "silk/LP_variable_cutoff.c",
    "silk/NLSF_decode.c",
    "silk/NSQ.c",
    "silk/NSQ_del_dec.c",
    "silk/PLC.c",
    "silk/shell_coder.c",
    "silk/tables_gain.c",
    "silk/tables_LTP.c",
    "silk/tables_NLSF_CB_NB_MB.c",
    "silk/tables_NLSF_CB_WB.c",
    "silk/tables_other.c",
    "silk/tables_pitch_lag.c",
    "silk/tables_pulses_per_block.c",
    "silk/VAD.c",
    "silk/control_audio_bandwidth.c",
    "silk/quant_LTP_gains.c",
    "silk/VQ_WMat_EC.c",
    "silk/HP_variable_cutoff.c",
    "silk/NLSF_encode.c",
    "silk/NLSF_VQ.c",
    "silk/NLSF_unpack.c",
    "silk/NLSF_del_dec_quant.c",
    "silk/process_NLSFs.c",
    "silk/stereo_LR_to_MS.c",
    "silk/stereo_MS_to_LR.c",
    "silk/check_control_input.c",
    "silk/control_SNR.c",
    "silk/init_encoder.c",
    "silk/control_codec.c",
    "silk/A2NLSF.c",
    "silk/ana_filt_bank_1.c",
    "silk/biquad_alt.c",
    "silk/bwexpander_32.c",
    "silk/bwexpander.c",
    "silk/debug.c",
    "silk/decode_pitch.c",
    "silk/inner_prod_aligned.c",
    "silk/lin2log.c",
    "silk/log2lin.c",
    "silk/LPC_analysis_filter.c",
    "silk/LPC_inv_pred_gain.c",
    "silk/table_LSF_cos.c",
    "silk/NLSF2A.c",
    "silk/NLSF_stabilize.c",
    "silk/NLSF_VQ_weights_laroia.c",
    "silk/pitch_est_tables.c",
    "silk/resampler.c",
    "silk/resampler_down2_3.c",
    "silk/resampler_down2.c",
    "silk/resampler_private_AR2.c",
    "silk/resampler_private_down_FIR.c",
    "silk/resampler_private_IIR_FIR.c",
    "silk/resampler_private_up2_HQ.c",
    "silk/resampler_rom.c",
    "silk/sigm_Q15.c",
    "silk/sort.c",
    "silk/sum_sqr_shift.c",
    "silk/stereo_decode_pred.c",
    "silk/stereo_encode_pred.c",
    "silk/stereo_find_predictor.c",
    "silk/stereo_quant_pred.c",
    "silk/LPC_fit.c",
]

SILK_SOURCES_FLOAT = [
    "silk/float/apply_sine_window_FLP.c",
    "silk/float/corrMatrix_FLP.c",
    "silk/float/encode_frame_FLP.c",
    "silk/float/find_LPC_FLP.c",
    "silk/float/find_LTP_FLP.c",
    "silk/float/find_pitch_lags_FLP.c",
    "silk/float/find_pred_coefs_FLP.c",
    "silk/float/LPC_analysis_filter_FLP.c",
    "silk/float/LTP_analysis_filter_FLP.c",
    "silk/float/LTP_scale_ctrl_FLP.c",
    "silk/float/noise_shape_analysis_FLP.c",
    "silk/float/process_gains_FLP.c",
    "silk/float/regularize_correlations_FLP.c",
    "silk/float/residual_energy_FLP.c",
    "silk/float/warped_autocorrelation_FLP.c",
    "silk/float/wrappers_FLP.c",
    "silk/float/autocorrelation_FLP.c",
    "silk/float/burg_modified_FLP.c",
    "silk/float/bwexpander_FLP.c",
    "silk/float/energy_FLP.c",
    "silk/float/inner_product_FLP.c",
    "silk/float/k2a_FLP.c",
    "silk/float/LPC_inv_pred_gain_FLP.c",
    "silk/float/pitch_analysis_core_FLP.c",
    "silk/float/scale_copy_vector_FLP.c",
    "silk/float/scale_vector_FLP.c",
    "silk/float/schur_FLP.c",
    "silk/float/sort_FLP.c",
]

OPUS_SOURCES = [
    "src/opus.c",
    "src/opus_decoder.c",
    "src/opus_encoder.c",
    "src/extensions.c",
    "src/opus_multistream.c",
    "src/opus_multistream_encoder.c",
    "src/opus_multistream_decoder.c",
    "src/repacketizer.c",
    "src/opus_projection_encoder.c",
    "src/opus_projection_decoder.c",
    "src/mapping_matrix.c",
]

OPUS_SOURCES_FLOAT = [
    "src/analysis.c",
    "src/mlp.c",
    "src/mlp_data.c",
]

SRCS = CELT_SOURCES + SILK_SOURCES + SILK_SOURCES_FLOAT + OPUS_SOURCES + OPUS_SOURCES_FLOAT

PUBLIC_HEADERS = [
    "opus.h",
    "opus_defines.h",
    "opus_multistream.h",
    "opus_projection.h",
    "opus_types.h",
]

# Upstream's tests (tests/meson.build), each a program of its own, with
# the extra sources it takes. test_opus_extensions and test_opus_projection
# reach private symbols, which a static library linked with hidden
# visibility does not export, so they are left out.
TESTS = {
    "test_opus_api": [],
    "test_opus_decode": [],
    "test_opus_encode": ["tests/opus_encode_regressions.c"],
    "test_opus_padding": [],
}

shims.http_archive(
    name = "src",
    sha256 = "65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1",
    strip_prefix = "opus-{}".format(VERSION),
    sub_targets = sorted(
        SRCS +
        ["include/" + h for h in PUBLIC_HEADERS] +
        ["tests/{}.c".format(t) for t in TESTS] +
        [s for extra in TESTS.values() for s in extra],
    ),
    type = "tar.gz",
    urls = [
        "https://github.com/xiph/opus/releases/download/v{0}/opus-{0}.tar.gz".format(VERSION),
    ],
)

# What config.h would say (configure.ac), without one: sources include it
# only with HAVE_CONFIG_H. C99's variable-length arrays for scratch space,
# as configure picks where the compiler has them.
OPUS_DEFINES = [
    "-DOPUS_BUILD",
    "-DVAR_ARRAYS",
    "-DHAVE_LRINT",
    "-DHAVE_LRINTF",
    "-DPACKAGE_VERSION=\"{}\"".format(VERSION),
]

# The sources name each other's headers by bare name, from these
# directories, so the whole unpacked tree is on the include path.
OPUS_INCLUDES = [
    "-I$(location :src)/" + d
    for d in [
        "include",
        "celt",
        "silk",
        "silk/float",
        "src",
    ]
]

shims.cxx_library(
    name = "opus",
    srcs = [":src[{}]".format(f) for f in SRCS],
    compiler_flags = [
        "-std=gnu11",
        "-fvisibility=hidden",
    ],
    exported_headers = {
        "opus/" + h: ":src[include/{}]".format(h)
        for h in PUBLIC_HEADERS
    },
    exported_linker_flags = ["-lm"],
    header_namespace = "",
    preferred_linkage = "static",
    preprocessor_flags = OPUS_DEFINES + OPUS_INCLUDES,
    visibility = ["PUBLIC"],
)

# MARK: Tests

[
    shims.cxx_binary(
        name = test,
        srcs = [":src[tests/{}.c]".format(test)] + [":src[{}]".format(s) for s in extra],
        compiler_flags = ["-std=gnu11"],
        preprocessor_flags = OPUS_DEFINES + OPUS_INCLUDES,
        deps = [":opus"],
    )
    for test, extra in TESTS.items()
]

[
    shims.command_test(
        name = "upstream-" + test.removeprefix("test_opus_"),
        cmd = ["$(exe :{})".format(test)],
    )
    for test in TESTS
]
