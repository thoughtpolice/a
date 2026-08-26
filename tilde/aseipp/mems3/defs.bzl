# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Buck-managed, process-isolated mems3 resources for HTTP integration tests.

The setup helper starts the actual server on an ephemeral loopback port, waits
for its startup announcement, and transfers its PID to Buck for teardown. Each
resource exposes both AWS-compatible environment variables and Hurl variables.
Buck keys local resource pools by target label and holds a pool entry for the
duration of a test, so a test that mutates server state needs its own resource
target rather than one shared with other tests.
"""

load("@root//buck/tools/hurl:defs.bzl", "hurl")

def _mems3_local_resource_impl(ctx: AnalysisContext) -> list[Provider]:
    setup = cmd_args([
        ctx.attrs._setup[RunInfo].args,
        ctx.attrs.mems3[RunInfo].args,
    ])
    for bucket in ctx.attrs.buckets:
        setup.add("--bucket", bucket)
    for failpoint in ctx.attrs.failpoints:
        setup.add("--failpoint", failpoint)
    if ctx.attrs.fault_seed != None:
        setup.add("--fault-seed", str(ctx.attrs.fault_seed))
    if ctx.attrs.buggify:
        setup.add("--buggify")
    if ctx.attrs.buggify_activation != None:
        setup.add("--buggify-activation", str(ctx.attrs.buggify_activation))
    if ctx.attrs.buggify_firing != None:
        setup.add("--buggify-firing", str(ctx.attrs.buggify_firing))
    if ctx.attrs.auto_buggify:
        setup.add("--auto-buggify")
    if ctx.attrs.chaos_warmup_requests != None:
        setup.add("--chaos-warmup-requests", str(ctx.attrs.chaos_warmup_requests))
    if ctx.attrs.chaos_requests != None:
        setup.add("--chaos-requests", str(ctx.attrs.chaos_requests))
    if ctx.attrs.chaos_trace:
        setup.add("--chaos-trace")
    return [
        DefaultInfo(),
        RunInfo(args = setup),
        LocalResourceInfo(
            setup = setup,
            resource_env_vars = {
                "AWS_ACCESS_KEY_ID": "access_key_id",
                "AWS_REGION": "region",
                "AWS_SECRET_ACCESS_KEY": "secret_access_key",
                "HURL_VARIABLE_access_key_id": "access_key_id",
                "HURL_VARIABLE_endpoint": "endpoint",
                "HURL_VARIABLE_region": "region",
                "HURL_VARIABLE_secret_access_key": "secret_access_key",
                "MEMS3_ENDPOINT": "endpoint",
                "MEMS3_LOG": "log",
                "S3_ENDPOINT": "endpoint",
            },
            setup_timeout_seconds = 30,
        ),
    ]

_mems3_local_resource = rule(
    impl = _mems3_local_resource_impl,
    attrs = {
        "_setup": attrs.exec_dep(default = "tilde//aseipp/mems3/resource:resource", providers = [RunInfo]),
        "auto_buggify": attrs.bool(),
        "buckets": attrs.list(attrs.string()),
        "buggify": attrs.bool(),
        "buggify_activation": attrs.option(attrs.int(), default = None),
        "buggify_firing": attrs.option(attrs.int(), default = None),
        "chaos_requests": attrs.option(attrs.int(), default = None),
        "chaos_trace": attrs.bool(),
        "chaos_warmup_requests": attrs.option(attrs.int(), default = None),
        "failpoints": attrs.list(attrs.string()),
        "fault_seed": attrs.option(attrs.int(), default = None),
        "mems3": attrs.dep(providers = [RunInfo]),
    },
)

def mems3_local_resource(
        name: str,
        mems3: str = "tilde//aseipp/mems3:mems3",
        buckets: list[str] = ["celld"],
        failpoints: list[str] = [],
        fault_seed: int | None = None,
        buggify: bool = False,
        buggify_activation: int | None = None,
        buggify_firing: int | None = None,
        auto_buggify: bool = False,
        chaos_warmup_requests: int | None = None,
        chaos_requests: int | None = None,
        chaos_trace: bool = False,
        **kwargs):
    """Declare a local S3 fixture with the given initial buckets.

    ``mems3`` selects the tested binary in the target configuration. ``buckets``
    must be nonempty because mems3 itself defaults an absent list to ``celld``.
    Buck owns the server PID once setup succeeds; tests must not terminate it.

    ``failpoints`` contains ``NAME=PLAN`` strings, passed literally to mems3.
    ``fault_seed`` controls its faultline registry. ``buggify`` enables random
    fault injection; optional activation and firing percentages override the
    server defaults. Each resource owns its fault state and occurrence limits.

    ``auto_buggify`` runs the built-in adversarial profile. Optional warmup and
    campaign request counts bound it, and ``chaos_trace`` records fault
    decisions in ``MEMS3_LOG``. Automatic campaigns exclude explicit failpoints
    and basic BUGGIFY so a completed campaign can return to healthy operation.
    """
    if not buckets:
        fail("mems3_local_resource requires at least one initial bucket")
    if fault_seed != None and (fault_seed < 0 or fault_seed > 18446744073709551615):
        fail("fault_seed must be an unsigned 64-bit integer")
    for percentage in [buggify_activation, buggify_firing]:
        if percentage != None:
            if not buggify:
                fail("buggify percentages require buggify = True")
            if percentage < 0 or percentage > 100:
                fail("buggify percentages must be between 0 and 100")
    if auto_buggify and (buggify or failpoints):
        fail("auto_buggify cannot be combined with buggify or failpoints")
    if (chaos_warmup_requests != None or chaos_requests != None or chaos_trace) and not auto_buggify:
        fail("chaos settings require auto_buggify = True")
    if chaos_warmup_requests != None and (chaos_warmup_requests < 0 or chaos_warmup_requests > 18446744073709551615):
        fail("chaos_warmup_requests must be between 0 and 18446744073709551615")
    if chaos_requests != None and (chaos_requests <= 0 or chaos_requests > 18446744073709551615):
        fail("chaos_requests must be between 1 and 18446744073709551615")
    if chaos_requests != None and (chaos_warmup_requests or 0) + chaos_requests > 18446744073709551615:
        fail("chaos_warmup_requests + chaos_requests must fit in an unsigned 64-bit integer")
    _mems3_local_resource(
        name = name,
        mems3 = mems3,
        buckets = buckets,
        failpoints = failpoints,
        fault_seed = fault_seed,
        buggify = buggify,
        buggify_activation = buggify_activation,
        buggify_firing = buggify_firing,
        auto_buggify = auto_buggify,
        chaos_warmup_requests = chaos_warmup_requests,
        chaos_requests = chaos_requests,
        chaos_trace = chaos_trace,
        **kwargs
    )

def mems3_hurl_test(
        name: str,
        src: str,
        bucket: str = "hurl",
        failpoints: list[str] = [],
        fault_seed: int | None = None,
        buggify: bool = False,
        buggify_activation: int | None = None,
        buggify_firing: int | None = None,
        auto_buggify: bool = False,
        chaos_warmup_requests: int | None = None,
        chaos_requests: int | None = None,
        chaos_trace: bool = False,
        **kwargs):
    """Run one Hurl scenario against a private mems3 server.

    The server starts with ``bucket`` created, and the scenario receives it as
    ``{{bucket}}`` next to ``{{endpoint}}`` and the signing variables. Remaining
    keyword arguments go to ``hurl.test``. Fault settings are passed to the
    private resource, with the same meanings as ``mems3_local_resource``.
    """
    resource = name + "-resource"
    mems3_local_resource(
        name = resource,
        buckets = [bucket],
        failpoints = failpoints,
        fault_seed = fault_seed,
        buggify = buggify,
        buggify_activation = buggify_activation,
        buggify_firing = buggify_firing,
        auto_buggify = auto_buggify,
        chaos_warmup_requests = chaos_warmup_requests,
        chaos_requests = chaos_requests,
        chaos_trace = chaos_trace,
    )
    hurl.test(
        name = name,
        src = src,
        local_resources = {"mems3": ":" + resource},
        variables = {"bucket": bucket},
        **kwargs
    )
