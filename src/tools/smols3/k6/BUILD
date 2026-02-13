# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# Quick validation test - basic CRUD operations
depot.k6.run(
    name = "smoke",
    script = "smoke.js",
    initial_vus = 1,
    steps = [{"duration": "30s", "target": 1}],
)

# Sustained load test - typical production workload
depot.k6.run(
    name = "load",
    script = "load.js",
    initial_vus = 0,
    steps = [
        {"duration": "2m", "target": 10},   # Ramp up
        {"duration": "5m", "target": 10},   # Sustain
        {"duration": "2m", "target": 20},   # Ramp up more
        {"duration": "3m", "target": 20},   # Sustain at peak
        {"duration": "2m", "target": 0},    # Ramp down
    ],
)

# Stress test - push to find breaking points
depot.k6.run(
    name = "stress",
    script = "stress.js",
    initial_vus = 0,
    steps = [
        {"duration": "2m", "target": 50},   # Ramp up
        {"duration": "3m", "target": 50},   # Sustain
        {"duration": "2m", "target": 100},  # Push harder
        {"duration": "3m", "target": 100},  # Sustain
        {"duration": "2m", "target": 150},  # Max stress
        {"duration": "3m", "target": 150},  # Sustain
        {"duration": "2m", "target": 0},    # Ramp down
    ],
)

# Data integrity verification under load
depot.k6.run(
    name = "correctness",
    script = "correctness.js",
    initial_vus = 0,
    steps = [
        {"duration": "1m", "target": 20},   # Ramp up
        {"duration": "5m", "target": 20},   # Sustain
        {"duration": "1m", "target": 0},    # Ramp down
    ],
)

# Range read correctness and performance
depot.k6.run(
    name = "range",
    script = "range.js",
    initial_vus = 0,
    steps = [
        {"duration": "1m", "target": 15},   # Ramp up
        {"duration": "5m", "target": 15},   # Sustain
        {"duration": "1m", "target": 0},    # Ramp down
    ],
)

# Multipart upload testing
depot.k6.run(
    name = "multipart",
    script = "multipart.js",
    initial_vus = 0,
    steps = [
        {"duration": "1m", "target": 5},    # Ramp up
        {"duration": "3m", "target": 5},    # Sustain
        {"duration": "1m", "target": 0},    # Ramp down
    ],
)
