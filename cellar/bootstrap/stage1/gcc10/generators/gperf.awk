# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Turn one of gcc/cp's gperf inputs into the C++ interface its includer
# expects, without gperf. The class comes from "%define class-name" and the
# lookup function from -v lookup=NAME, as gperf's -N option would name it.
# The perfect hash becomes a table sorted by name and searched by bisection;
# lookups return the same entries for every string.

BEGIN {
    section = "options"
    count = 0
    if (lookup == "") {
        print "gperf.awk: set -v lookup=NAME" > "/dev/stderr"
        exit 1
    }
}

section == "options" && /^%define class-name / { class = $3; next }
section == "options" && $0 == "%{" { section = "header"; next }
section == "header" && $0 == "%}" { section = "declarations"; next }
section == "header" { print; next }
section == "declarations" && $0 == "%%" { section = "keywords"; next }
section == "declarations" {
    if ($1 == "struct" && structure == "")
        structure = $2
    declarations[lines++] = $0
    next
}
section == "keywords" && $0 == "%%" { section = "done"; next }
section == "keywords" && /^[^#]/ {
    field = index($0, ",")
    names[count] = substr($0, 1, field - 1)
    values[count] = substr($0, field + 1)
    sub(/^ */, "", values[count])
    count++
    next
}

END {
    if (section != "keywords" && section != "done" || class == "" || structure == "") {
        print "gperf.awk: incomplete gperf input" > "/dev/stderr"
        exit 1
    }
    # Insertion sort by byte order, which the lookup's memcmp follows.
    for (i = 0; i < count; i++) {
        entry = i
        for (j = i - 1; j >= 0 && names[order[j]] "" > names[entry] ""; j--)
            order[j + 1] = order[j]
        order[j + 1] = entry
    }
    for (i = 0; i < lines; i++)
        print declarations[i]
    print ""
    print "class " class
    print "{"
    print "public:"
    print "  static const struct " structure " *" lookup " (const char *str, size_t len);"
    print "};"
    print ""
    print "static const struct " structure " " class "_table[] ="
    print "  {"
    for (i = 0; i < count; i++)
        printf "    {\"%s\", %s},\n", names[order[i]], values[order[i]]
    print "  };"
    print ""
    print "const struct " structure " *"
    print class "::" lookup " (const char *str, size_t len)"
    print "{"
    print "  size_t low = 0, high = sizeof " class "_table / sizeof " class "_table[0];"
    print "  while (low < high)"
    print "    {"
    print "      size_t middle = low + (high - low) / 2;"
    print "      size_t name_len = strlen (" class "_table[middle].name);"
    print "      int order = memcmp (" class "_table[middle].name, str, name_len < len ? name_len : len);"
    print "      if (order == 0)"
    print "        order = (name_len > len) - (name_len < len);"
    print "      if (order == 0)"
    print "        return &" class "_table[middle];"
    print "      if (order < 0)"
    print "        low = middle + 1;"
    print "      else"
    print "        high = middle;"
    print "    }"
    print "  return 0;"
    print "}"
}
