#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""Validate comparison coverage from Buck uquery JSON, never as a build input.

Pass the c_object target list and command_test targets with their args attribute
for both stage1/gcc47 and stage1/libstdcxx. Only the two upstream compiler
checksum objects may be excluded. The actual byte comparisons run in Buck.
"""

import argparse
import json
import re
import sys


def audit(objects, tests):
    left = {label for label in objects if ":stage2-" in label}
    right = {label for label in objects if ":stage3-" in label}
    expected_right = {label.replace(":stage2-", ":stage3-") for label in left}
    errors = []
    if not left or right != expected_right:
        errors.append("stage2/stage3 object inventories differ or are empty")
    excluded = {
        "depot-cellar//bootstrap/stage1/gcc47:stage2-cc1-checksum.o",
        "depot-cellar//bootstrap/stage1/gcc47:stage2-cc1plus-checksum.o",
    }
    compared = set()
    other = set()
    for label, attributes in tests.items():
        if ":compare-" not in label:
            continue
        args = attributes.get("args", [])
        matches = [re.fullmatch(r"\$\(location ([^)]+)\)", arg) for arg in args]
        if len(matches) != 2 or not all(matches):
            errors.append("comparison must name two artifacts: " + label)
            continue
        a, b = [match.group(1) for match in matches]
        if ":stage2-" not in a or b != a.replace(":stage2-", ":stage3-"):
            errors.append("comparison does not pair corresponding stages: " + label)
        elif a in left:
            compared.add(a)
        else:
            other.add(a)
    if left - compared != excluded:
        errors.append("unexpected excluded objects: " + repr(sorted((left - compared) ^ excluded)))
    return {
        "stage2_objects": len(left),
        "stage3_objects": len(right),
        "compared_objects": len(compared),
        "excluded_objects": sorted(left - compared),
        "additional_compared_artifacts": sorted(other),
        "errors": errors,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--objects", required=True)
    parser.add_argument("--tests", required=True)
    args = parser.parse_args()
    with open(args.objects) as stream:
        objects = json.load(stream)
    with open(args.tests) as stream:
        tests = json.load(stream)
    result = audit(objects, tests)
    print(json.dumps(result, indent=2))
    sys.exit(bool(result["errors"]))
