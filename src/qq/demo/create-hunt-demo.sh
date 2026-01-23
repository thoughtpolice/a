#!/bin/bash
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
#
# Create a demo repository for testing qq hunt's flake-aware bisection.
#
# This script creates a git repository with:
#   - A configurable number of commits
#   - A bug introduced at a random position
#   - A test script with configurable flaky behavior
#
# Usage:
#   ./create-hunt-demo.sh [--commits N] [--flake-percent P] [--output-dir DIR]

set -euo pipefail

# =============================================================================
# Configuration
# =============================================================================

NUM_COMMITS=100
FLAKE_PERCENT=10
OUTPUT_DIR=""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# =============================================================================
# Argument parsing
# =============================================================================

print_usage() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS]

Create a demo repository for qq hunt flake-aware bisection.

Options:
    --commits N        Number of commits to generate (default: 100)
    --flake-percent P  Flake rate percentage 0-100 (default: 10)
    --output-dir DIR   Output directory (default: /tmp/hunt-demo-PID)
    -h, --help         Show this help message

Examples:
    $(basename "$0")                          # Use defaults
    $(basename "$0") --commits 50             # Shorter history
    $(basename "$0") --flake-percent 20       # More flakiness
    $(basename "$0") --output-dir ~/demo      # Custom location
EOF
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --commits)
            NUM_COMMITS="$2"
            shift 2
            ;;
        --flake-percent)
            FLAKE_PERCENT="$2"
            shift 2
            ;;
        --output-dir)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            print_usage
            exit 1
            ;;
    esac
done

# Set default output directory if not specified
if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="/tmp/hunt-demo-$$"
fi

# Validate arguments
if [[ "$NUM_COMMITS" -lt 10 ]]; then
    echo "Error: Need at least 10 commits for a meaningful demo"
    exit 1
fi

if [[ "$FLAKE_PERCENT" -lt 0 ]] || [[ "$FLAKE_PERCENT" -gt 100 ]]; then
    echo "Error: Flake percent must be between 0 and 100"
    exit 1
fi

# =============================================================================
# Helper functions
# =============================================================================

log_info() {
    echo -e "${BLUE}==>${NC} $*"
}

log_success() {
    echo -e "${GREEN}==>${NC} $*"
}

log_warning() {
    echo -e "${YELLOW}==>${NC} $*"
}

# =============================================================================
# Main script
# =============================================================================

echo ""
echo -e "${BOLD}Creating hunt demo repository${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Commits:     $NUM_COMMITS"
echo "  Flake rate:  ${FLAKE_PERCENT}%"
echo "  Location:    $OUTPUT_DIR"
echo ""

# Check if jj is available
if ! command -v jj &> /dev/null; then
    echo "Error: jj (jujutsu) is not installed or not in PATH"
    exit 1
fi

# Create output directory
if [[ -d "$OUTPUT_DIR" ]]; then
    log_warning "Directory already exists, removing: $OUTPUT_DIR"
    rm -rf "$OUTPUT_DIR"
fi

mkdir -p "$OUTPUT_DIR"
cd "$OUTPUT_DIR"

# Initialize repository
log_info "Initializing jj repository..."
jj git init --quiet

# Calculate bug position (not too early, not too late)
MIN_BUG_POS=5
MAX_BUG_POS=$((NUM_COMMITS - 5))
BUG_POSITION=$(shuf -i "$MIN_BUG_POS"-"$MAX_BUG_POS" -n 1)

log_info "Bug will be introduced at commit ${BOLD}$BUG_POSITION${NC} of $NUM_COMMITS"
echo ""

# Create the test script (this stays constant across all commits)
cat > test.sh << 'TESTSCRIPT'
#!/bin/bash
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
#
# Test script for hunt demo - has deterministic bug detection + flaky behavior
#
# Exit codes:
#   0   - PASS (test passed)
#   1   - FAIL (test failed - either real bug or flake)
#   125 - SKIP (untestable commit)
#   127 - ABORT (fatal error, stop bisection)

set -euo pipefail

# Flake rate is controlled by environment variable (default 10%)
FLAKE_PERCENT="${FLAKE_PERCENT:-10}"

# Deterministic bug check - if CONTAINS_BUG marker exists, always fail
if grep -q 'CONTAINS_BUG' code.txt 2>/dev/null; then
    echo "FAIL: Bug detected in code.txt (deterministic failure)"
    exit 1
fi

# Flaky behavior - random failure even on good code
# This simulates real-world test flakiness (timing issues, resource exhaustion, etc.)
ROLL=$(shuf -i 1-100 -n 1)
if [[ "$ROLL" -le "$FLAKE_PERCENT" ]]; then
    echo "FAIL: Random flake (roll=$ROLL <= threshold=$FLAKE_PERCENT)"
    exit 1
fi

echo "PASS: All checks passed (roll=$ROLL > threshold=$FLAKE_PERCENT)"
exit 0
TESTSCRIPT
chmod +x test.sh

# Create initial code file
cat > code.txt << 'CODEFILE'
# Application Configuration
# =========================
# This file simulates application code that will have a bug introduced.

version = "1.0.0"
author = "Demo Author"
status = "stable"

# Feature flags
feature_alpha = true
feature_beta = false

# Performance settings
max_connections = 100
timeout_seconds = 30
CODEFILE

# Save metadata about this demo
cat > .hunt-demo-info << EOF
# Hunt Demo Repository Metadata
# Generated: $(date -Iseconds)
#
# This repository was created for demonstrating qq hunt's
# flake-aware bisection algorithm (FACF).
#
NUM_COMMITS=$NUM_COMMITS
BUG_POSITION=$BUG_POSITION
FLAKE_PERCENT=$FLAKE_PERCENT
EOF

# Initial commit (suppress jj output for cleaner demo output)
jj commit -m 'init: initial commit with test framework' \
    --config=user.name=Demo --config=user.email=demo@example.com \
    > /dev/null 2>&1

# Generate commit history
log_info "Generating $NUM_COMMITS commits..."

for i in $(seq 1 "$NUM_COMMITS"); do
    # Add an innocuous change to simulate development activity
    echo "" >> code.txt
    echo "# Commit $i - development change $(date +%s%N | cut -c1-13)" >> code.txt

    if [[ "$i" -eq "$BUG_POSITION" ]]; then
        # Introduce the bug!
        echo "" >> code.txt
        echo "# WARNING: Bug introduced below" >> code.txt
        echo "CONTAINS_BUG = true" >> code.txt

        jj commit -m "feat: commit $i (BUG INTRODUCED)" \
            --config=user.name=Demo --config=user.email=demo@example.com \
            > /dev/null 2>&1
    else
        jj commit -m "feat: commit $i" \
            --config=user.name=Demo --config=user.email=demo@example.com \
            > /dev/null 2>&1
    fi

    # Progress indicator every 10 commits
    if [[ $((i % 10)) -eq 0 ]]; then
        echo -ne "\r  Progress: $i/$NUM_COMMITS commits..."
    fi
done

echo -e "\r  Progress: $NUM_COMMITS/$NUM_COMMITS commits... done!    "
echo ""

# Final summary
log_success "Demo repository created successfully!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ${BOLD}Bug location:${NC}  commit $BUG_POSITION of $NUM_COMMITS"
echo -e "  ${BOLD}Flake rate:${NC}    ${FLAKE_PERCENT}%"
echo -e "  ${BOLD}Repository:${NC}    $OUTPUT_DIR"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "${GREEN}To find the bug with flake-aware hunt:${NC}"
echo ""
echo "  cd $OUTPUT_DIR"

# Calculate flake rate as decimal for qq hunt
FLAKE_DECIMAL=$(echo "scale=2; $FLAKE_PERCENT / 100" | bc)

echo "  FLAKE_PERCENT=$FLAKE_PERCENT qq hunt run -r 'root()..@' -f $FLAKE_DECIMAL ./test.sh"
echo ""
echo "The FACF algorithm will use Bayesian inference to find the"
echo "culprit despite noisy test results. Expected result: position $BUG_POSITION"
echo ""
echo -e "${YELLOW}Why traditional bisect fails here:${NC}"
echo "  With ${FLAKE_PERCENT}% flake rate, ~$((NUM_COMMITS * FLAKE_PERCENT / 100)) tests will randomly fail"
echo "  even on good commits. Traditional bisect would likely converge"
echo "  on the wrong commit or give up entirely."
echo ""
