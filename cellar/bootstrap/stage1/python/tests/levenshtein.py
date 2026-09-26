# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Checks the shipped Lib/test/levenshtein_examples.json against
# Tools/build/generate_levenshtein_examples.py, which draws its examples at
# random: each example must carry the distance the generator's own function
# gives, the set must have the generator's shape, and the file must be those
# examples as the generator writes them.

import importlib.util
import json
import sys

generator_path, examples_path = sys.argv[1:]
spec = importlib.util.spec_from_file_location("generator", generator_path)
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)

with open(examples_path) as file:
    text = file.read()
examples = {tuple(example) for example in json.loads(text)}
assert len(examples) == 10000, len(examples)
for a, b, expected in examples:
    assert generator.levenshtein(a, b) == expected, (a, b, expected)
empty = sorted(len(b) for a, b, _ in examples if not a)
assert empty == list(range(10)), empty
assert json.dumps(sorted(examples), indent=2) == text
