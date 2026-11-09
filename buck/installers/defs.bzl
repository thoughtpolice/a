# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Rules for targets `buck2 install` installs: any files, with an installer
of their own (installable); and macOS apps, bundles the app installer puts
in ~/Applications (macos_app)."""

def _installable_impl(ctx: AnalysisContext) -> list[Provider]:
    installer = ctx.attrs.installer
    providers = [
        InstallInfo(
            installer = installer,
            files = ctx.attrs.files,
        ),
    ]
    main = ctx.attrs.main
    if main == None:
        return providers + [DefaultInfo()]
    providers.append(main[DefaultInfo])
    if RunInfo in main:
        providers.append(main[RunInfo])
    return providers

installable = rule(
    impl = _installable_impl,
    attrs = {
        "files": attrs.dict(
            key = attrs.string(),
            value = attrs.source(),
            default = {},
        ),
        "installer": attrs.label(),
        "main": attrs.option(
            attrs.dep(),
            default = None,
            doc = "A target this one stands for otherwise: it builds its outputs and runs it, so that one name can be built, run and installed.",
        ),
    },
)

def _macos_app_impl(ctx: AnalysisContext) -> list[Provider]:
    name = ctx.label.name
    if not name.endswith(".app") or name == ".app":
        fail("macos_app: a bundle's target is named as the bundle is, NAME.app, not {}".format(name))
    executable = ctx.attrs.executable[DefaultInfo].default_outputs[0]
    program = ctx.attrs.executable_name or executable.basename
    contents = {
        "Contents/Info.plist": ctx.attrs.info_plist,
        "Contents/MacOS/" + program: executable,
    }
    for path, src in ctx.attrs.resources.items():
        contents["Contents/Resources/" + path] = src
    bundle = ctx.actions.copied_dir(name, contents)
    return [
        DefaultInfo(default_output = bundle),
        # Run from inside the bundle, so that it is the app's: its name,
        # its icon in the Dock.
        RunInfo(args = cmd_args(bundle.project("Contents/MacOS/" + program))),
        InstallInfo(
            installer = ctx.attrs.installer,
            files = {name: bundle},
        ),
    ]

# A macOS app: a bundle, NAME.app, of an executable, its Info.plist and its
# resources, which `buck2 build` makes, `buck2 run` runs, and `buck2 install`
# puts in ~/Applications (`-- --dir DIR` puts it elsewhere).
macos_app = rule(
    impl = _macos_app_impl,
    attrs = {
        "executable": attrs.dep(
            doc = "The app's program: its default output goes in Contents/MacOS.",
        ),
        "executable_name": attrs.option(
            attrs.string(),
            default = None,
            doc = "The program's name in Contents/MacOS, which Info.plist's CFBundleExecutable names: by default, its output's own.",
        ),
        "info_plist": attrs.source(
            doc = "Contents/Info.plist: the app's name, identifier, executable, icon, and the rest.",
        ),
        "installer": attrs.label(default = "root//buck/installers/app:app"),
        "resources": attrs.dict(
            key = attrs.string(),
            value = attrs.source(),
            default = {},
            doc = "Files in Contents/Resources, by their paths there: the icon Info.plist's CFBundleIconFile names, say.",
        ),
    },
)
