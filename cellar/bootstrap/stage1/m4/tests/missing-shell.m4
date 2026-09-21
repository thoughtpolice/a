syscmd(`exit 0')dnl
ifelse(sysval, `127', `m4exit(0)', `m4exit(1)')dnl
