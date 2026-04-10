
def __constraint_setting_impl(ctx):
    return [DefaultInfo(), ConstraintSettingInfo(label = ctx.label.raw_target())]

constraint_setting = rule(impl = __constraint_setting_impl, attrs = {})

def __constraint_value_impl(ctx):
    setting = ctx.attrs.setting[ConstraintSettingInfo]
    cv = ConstraintValueInfo(setting = setting, label = ctx.label.raw_target())
    return [
        DefaultInfo(),
        cv,
        ConfigurationInfo(constraints = {setting.label: cv}, values = {}),
    ]

constraint_value = rule(impl = __constraint_value_impl, attrs = {
    "setting": attrs.dep(providers = [ConstraintSettingInfo]),
})

def __platform_impl(ctx):
    constraints = {}
    for dep in ctx.attrs.constraint_values:
        cv = dep[ConstraintValueInfo]
        constraints[cv.setting.label] = cv
    cfg = ConfigurationInfo(constraints = constraints, values = {})
    return [
        DefaultInfo(),
        PlatformInfo(label = str(ctx.label.raw_target()), configuration = cfg),
    ]

platform = rule(impl = __platform_impl, attrs = {
    "constraint_values": attrs.list(attrs.dep(providers = [ConstraintValueInfo])),
})

def create():
    constraint_setting(name = "os")
    constraint_value(name = "linux", setting = ":os")

    constraint_setting(name = "cpu")
    constraint_value(name = "amd64", setting = ":cpu")
    constraint_value(name = "aarch64", setting = ":cpu")

    cv = []
    h = host_info()
    if h.os.is_linux:
        cv.append(":linux")
    if h.arch.is_x86_64:
        cv.append(":amd64")
    elif h.arch.is_aarch64:
        cv.append(":aarch64")

    platform(name = "default", constraint_values = cv)
