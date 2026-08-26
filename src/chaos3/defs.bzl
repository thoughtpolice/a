# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Buck-managed, process-isolated chaos3 resources for HTTP integration tests.

The setup helper starts the actual server on an ephemeral loopback port, waits
for the endpoint it writes to a readiness pipe, and transfers its PID to Buck
for teardown. Each
resource exposes both AWS-compatible environment variables and Hurl variables.
Buck keys local resource pools by target label and holds a pool entry for the
duration of a test, so a test that mutates server state needs its own resource
target rather than one shared with other tests.
"""

load("@root//buck/tools/hurl:defs.bzl", "hurl")

# Fault settings, in the order the server receives them. Each rule attribute
# maps to one chaos3 flag. A boolean passes the bare flag, a list repeats the
# flag per item, and any other value follows the flag as its argument. chaos3
# validates the values and their combinations when the resource starts.
_FAULT_OPTIONS = [
    struct(attr = "failpoints", flag = "--failpoint", spec = attrs.list(attrs.string(), default = [])),
    struct(attr = "fault_seed", flag = "--fault-seed", spec = attrs.option(attrs.int(), default = None)),
    struct(attr = "chaos", flag = "--chaos", spec = attrs.option(attrs.string(), default = None)),
    struct(attr = "chaos_warmup_requests", flag = "--chaos-warmup-requests", spec = attrs.option(attrs.int(), default = None)),
    struct(attr = "chaos_requests", flag = "--chaos-requests", spec = attrs.option(attrs.int(), default = None)),
    struct(attr = "chaos_trace", flag = "--chaos-trace", spec = attrs.bool(default = False)),
]

_FAULT_ATTRS = {option.attr: option.spec for option in _FAULT_OPTIONS}

def _chaos3_local_resource_impl(ctx: AnalysisContext) -> list[Provider]:
    setup = cmd_args([
        ctx.attrs._setup[RunInfo].args,
        ctx.attrs.chaos3[RunInfo].args,
    ])
    for bucket in ctx.attrs.buckets:
        setup.add("--bucket", bucket)
    for option in _FAULT_OPTIONS:
        value = getattr(ctx.attrs, option.attr)
        if type(value) == "bool":
            if value:
                setup.add(option.flag)
        elif type(value) == "list":
            for item in value:
                setup.add(option.flag, item)
        elif value != None:
            setup.add(option.flag, str(value))
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
                "CHAOS3_ENDPOINT": "endpoint",
                "CHAOS3_LOG": "log",
                "S3_ENDPOINT": "endpoint",
            },
            setup_timeout_seconds = 30,
        ),
    ]

_chaos3_local_resource = rule(
    impl = _chaos3_local_resource_impl,
    attrs = dict(
        _FAULT_ATTRS,
        _setup = attrs.exec_dep(default = "root//src/chaos3/resource:resource", providers = [RunInfo]),
        buckets = attrs.list(attrs.string()),
        chaos3 = attrs.dep(providers = [RunInfo]),
    ),
)

def chaos3_local_resource(
        name: str,
        chaos3: str = "root//src/chaos3:chaos3",
        buckets: list[str] = ["celld"],
        **kwargs):
    """Declare a local S3 fixture with the given initial buckets.

    ``chaos3`` selects the tested binary in the target configuration. ``buckets``
    must be nonempty because chaos3 itself defaults an absent list to ``celld``.
    Buck owns the server PID once setup succeeds; tests must not terminate it.

    Fault settings are keyword arguments named after the server's flags.
    ``failpoints`` lists ``NAME=PLAN`` strings and ``fault_seed`` seeds the
    faultline registry. ``chaos`` names the adversarial profile to run, which
    is ``storage-v1``, bounded by ``chaos_warmup_requests`` and
    ``chaos_requests``, and
    ``chaos_trace`` records its decisions in ``CHAOS3_LOG``. Each resource owns
    its fault state and occurrence limits. chaos3 checks the values and their
    combinations when the resource starts, so a bad setting fails test setup
    with the server's usage error.
    """
    if not buckets:
        fail("chaos3_local_resource requires at least one initial bucket")
    _chaos3_local_resource(
        name = name,
        chaos3 = chaos3,
        buckets = buckets,
        **kwargs
    )

def chaos3_hurl_test(name: str, src: str, bucket: str = "hurl", **kwargs):
    """Run one Hurl scenario against a private chaos3 server.

    The server starts with ``bucket`` created, and the scenario receives it as
    ``{{bucket}}`` next to ``{{endpoint}}`` and the signing variables. Fault
    settings go to the private resource with the same meanings as for
    ``chaos3_local_resource``. The remaining keyword arguments go to
    ``hurl.test``.
    """
    resource_kwargs = {}
    for attr in _FAULT_ATTRS:
        if attr in kwargs:
            resource_kwargs[attr] = kwargs.pop(attr)
    resource = name + "-resource"
    chaos3_local_resource(
        name = resource,
        buckets = [bucket],
        **resource_kwargs
    )
    hurl.test(
        name = name,
        src = src,
        local_resources = {"chaos3": ":" + resource},
        variables = {"bucket": bucket},
        **kwargs
    )
