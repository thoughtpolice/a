# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//cfg/modifier:cfg_constructor.bzl", "cfg_constructor_post_constraint_analysis", "cfg_constructor_pre_constraint_analysis")
load("@prelude//cfg/modifier:common.bzl", "MODIFIER_METADATA_KEY")
load("@prelude//cfg/modifier:set_cfg_modifiers.bzl", "set_cfg_modifiers")

# MARK: Metadata

def _meta_write_package_value(k: str, v) -> None:
    # FIXME (aseipp): propagate overwrite upwards so it can be conditionally
    # enabled
    return write_package_value("meta.{}".format(k), v, overwrite = True)

PackageMetaField = enum(
    "license",
    "description",
    "version",
    "copyright",
    "vendor",
    "osv",
)

OsvPurlInfo = record(name = field(str), version = field(None | str, default = None))
OsvGitRepoInfo = record(url = field(str), commit = field(str))

def _license(s: str) -> None:
    """Set the license of the current package."""
    return _meta_write_package_value("license", s.strip())

def _description(s: str) -> None:
    """Set the description of the current package."""
    return _meta_write_package_value("description", s.strip())

def _version(s: str) -> None:
    """Set the version of the current package."""

    # Upstream versions as their projects spell them: dotted numbers, which
    # need not be semver (Verilator's "5.052"), with optional semver-style
    # pre-release and build suffixes.
    r = "^[0-9]+(?:\\.[0-9]+)*(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$"
    if not regex_match(r, s):
        fail("Invalid version, must be dotted numbers with optional -pre and +build suffixes: {}".format(s))
    return _meta_write_package_value("version", s.strip())

def _copyright(cc: list[str]) -> None:
    """Set the license of the current package."""
    return _meta_write_package_value("copyright", cc)

def _vendored(meta: dict) -> None:
    """Set the vendored status of the current package."""
    _meta_write_package_value("vendor", meta)
    return None

def _osv_info(meta: dict) -> None:
    """Set the OSV metadata of the current package."""
    _meta_write_package_value("osv", meta)
    return None

def _info(
        copyright: list[str],
        license: str,
        description: None | str = None,
        version: None | str = None,
        vendored: bool = False,
        vendor_info: dict = {},
        osv_info: None | OsvPurlInfo | OsvGitRepoInfo = None,
        inherit: bool = False,
        visibility: list[str] = [],
        within_view: list[str] = [],
        target_compatible_with: None | list[str] = None,
        compatible_with: None | list[str] = None) -> None:
    _copyright(copyright)
    _license(license)
    if description != None:
        _description(description)
    if version != None:
        _version(version)

    if osv_info != None:
        if isinstance(osv_info, OsvPurlInfo):
            _osv_info({
                "type": "OsvPurlInfo",
                "purl": osv_info.name,
                "version": osv_info.version or version if version != None else fail("Must specify version for OSV PURL info"),
            })
        elif isinstance(osv_info, OsvGitRepoInfo):
            _osv_info({
                "type": "OsvGitRepoInfo",
                "url": osv_info.url,
                "commit": osv_info.commit,
            })
        else:
            fail("Invalid OSV info type: {}".format(osv_info))

    if vendored:
        if vendor_info == {}:
            fail("Must specify upstream vendor metadata (vendor_info) when package is vendored code")
        _vendored(vendor_info)

    # Buck2 rejects a target that carries both compatibility attributes, so a
    # package supplies at most one default: target_compatible_with requires
    # every entry to match, compatible_with any one of them.
    if target_compatible_with != None and compatible_with != None:
        fail("Specify either target_compatible_with or compatible_with, not both")
    if target_compatible_with != None:
        _meta_write_package_value("target_compatible_with", target_compatible_with)
    if compatible_with != None:
        _meta_write_package_value("compatible_with", compatible_with)

    package(
        inherit = inherit,
        visibility = visibility,
        within_view = within_view,
    )
    return None

def __get_pkg_path() -> str:
    """Get the path to the PACKAGE file for the current package."""
    return "{}//{}/PACKAGE".format(
        get_cell_name(),
        package_name(),
    )

def third_party_meta(names: list[str]):
    _meta_write_package_value("3p", names)

# MARK: Source checks

def _srclint(sources: bool) -> None:
    """Turn the srclint tests of targets' sources on or off for this package
    and those below it.

    See buck/shims/srclint.bzl. They are on by default, and off in a package
    whose `info` says it is vendored. The test of a package's own build files
    is always on, but leaves out the SPDX check where the sources' are off.
    """
    write_package_value("srclint.sources", sources, overwrite = True)

# MARK: Modifiers

def set_cfg_constructor(aliases = dict()):
    native.set_cfg_constructor(
        stage0 = cfg_constructor_pre_constraint_analysis,
        stage1 = cfg_constructor_post_constraint_analysis,
        key = MODIFIER_METADATA_KEY,
        aliases = struct(**aliases),
        extra_data = struct(),
    )

# MARK: Public API

pkg = struct(
    info = _info,
    third_party_meta = third_party_meta,
    srclint = _srclint,
    get_path = __get_pkg_path,
    version = lambda: read_package_value("meta.version"),
    cfg_constructor = set_cfg_constructor,
    cfg_modifiers = set_cfg_modifiers,
)
