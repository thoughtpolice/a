# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is `bizarro.py`, a comprehensive MLX-based language model CLI tool that provides a complete fine-tuning and inference pipeline for local LLMs on Mac. The tool is built as a single-file Python script with inline dependency management using uv.

## You absolutely must must must must must

When you are done with a change, run the following:

```bash
buck2 test //src/tools/bizarro/...
```

at the final phase of testing EVERY change. I repeat: YOU MUST DO THESE TWO COMMANDS AFTER EVERY CHANGE TO FINALIZE IT AND FINISH YOUR JOB!

You SHOULD always test the logic you're looking to fix or add directly by running `./bizarro.py` directly. After that you can use `runtests.sh` when you're finalizing things, as it's fairly expensive to run.

## Essential Commands

### Linting and Formatting
```bash
# Run lint checks (ruff check + format check)
buck2 test //src/tools/bizarro:lint

# Run formatter to fix code style
buck2 run //src/tools/bizarro:format
```

### Testing
```bash
# Run full integration test suite
buck2 test //src/tools/bizarro:test

# Run individual quick tests
buck2 test //src/tools/bizarro:test-help
buck2 test //src/tools/bizarro:test-run-basic
```

### Build All
```bash
# Build all targets in the package
buck2 build //src/tools/bizarro:
```

### Running the Tool
```bash
# The script is self-contained with uv dependency management
buck2 run bizarro -- --help                    # Show all commands
buck2 run bizarro -- run "What is AI?" --model Qwen/Qwen3-0.6B
buck2 run bizarro -- chat --model Qwen/Qwen3-0.6B
```

### Fine-tuning Workflow
```bash
# Complete fine-tuning pipeline
buck2 run bizarro -- tune Qwen/Qwen3-0.6B data/ --iters 10 --batch-size 1 --num-layers 4
buck2 run bizarro -- fuse Qwen/Qwen3-0.6B                    # Auto-detects latest adapter
buck2 run bizarro -- run "test prompt" --model fused_model   # Use fused model
```

### Quantization Support
```bash
# Quantize a model to reduce memory usage (3-8 bit quantization)
buck2 run bizarro -- quantize Qwen/Qwen3-0.6B --q-bits 4 --q-group-size 64
buck2 run bizarro -- quantize Qwen/Qwen3-0.6B --q-bits 8 --output-dir custom_quant_dir

# The quantized model can be used directly
buck2 run bizarro -- run "What is AI?" --model Qwen/Qwen3-0.6B_quantized_4bit

# De-quantize when fusing adapters
buck2 run bizarro -- fuse Qwen/Qwen3-0.6B --de-quantize --save-path dequantized_model
```

#### Quantization Options
- `--q-bits`: Number of quantization bits (3-8, default: 4)
- `--q-group-size`: Group size for quantization (default: 64)
- `--output-dir`: Output directory for quantized model (default: `{model}_quantized_{q_bits}bit`)
- `--de-quantize`: When fusing, generate a de-quantized (full precision) model

## Implementation Details

The BUILD file uses custom `uv` rules defined in `defs.bzl` that:
- Handle Python scripts with inline uv dependency management
- Provide linting via `uvx ruff check` and `uvx ruff format`
- Support running shell scripts as tests
- Work correctly with Buck2's execution from repository root

The tool itself remains a self-contained Python script with uv inline dependencies,
making it easy to run directly while also integrating with the Buck2 build system.
