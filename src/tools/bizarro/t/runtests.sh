#!/usr/bin/env bash

# Exit immediately if any command fails
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[TEST]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Create a temporary directory for all intermediate files
TEMP_DIR=$(mktemp -d)
print_status "Created temporary directory: $TEMP_DIR"

# Cleanup function to remove temporary directory
cleanup() {
    if [ -d "$TEMP_DIR" ]; then
        print_status "Cleaning up temporary directory: $TEMP_DIR"
        rm -rf "$TEMP_DIR"
    fi
}

# Set up trap to cleanup on exit (including errors)
trap cleanup EXIT

# Test configuration
BASE_MODEL="Qwen/Qwen3-0.6B"
QUANTIZED_MODEL="$TEMP_DIR/quantized_model"
ADAPTER_PATH="$TEMP_DIR/adapter"
FUSED_MODEL="$TEMP_DIR/fused_model"
DATA_PATH="src/tools/bizarro/data"

print_status "Starting comprehensive pipeline test"
print_status "Base model: $BASE_MODEL"

# Test 1: Basic run command
print_status "Test 1: Testing basic run command..."
src/tools/bizarro/bizarro.py run --no-stats "What is AI?" --model "$BASE_MODEL" --max-tokens 50 > /dev/null
print_status "✓ Basic run command successful"

# Test 2: Quantize the model to 4 bits
print_status "Test 2: Quantizing model to 4 bits..."
src/tools/bizarro/tuner.py quantize "$BASE_MODEL" --q-bits 4 --output-dir "$QUANTIZED_MODEL"
print_status "✓ Model quantized successfully to: $QUANTIZED_MODEL"

# Test 3: Fine-tune the quantized model
print_status "Test 3: Fine-tuning the quantized model..."
src/tools/bizarro/tuner.py tune "$QUANTIZED_MODEL" "$DATA_PATH" \
    --fine-tune-type lora \
    --num-layers 4 \
    --batch-size 2 \
    --iters 10 \
    --learning-rate 1e-5 \
    --adapter-path "$ADAPTER_PATH" \
    --max-seq-length 512 \
    --lora-rank 4 \
    --seed 42
print_status "✓ Model fine-tuned successfully, adapter saved to: $ADAPTER_PATH"

# Test 4: Fuse the adapter back into the model
print_status "Test 4: Fusing adapter into the model..."
src/tools/bizarro/tuner.py fuse "$QUANTIZED_MODEL" \
    --adapter-path "$ADAPTER_PATH" \
    --save-path "$FUSED_MODEL"
print_status "✓ Model fused successfully to: $FUSED_MODEL"

# Test 5: Run inference with the fused model
print_status "Test 5: Testing inference with fused model..."
OUTPUT=$(src/tools/bizarro/bizarro.py run "What is artificial intelligence?" \
    --model "$FUSED_MODEL" \
    --no-stats 2>&1)

# Check if output is non-empty
if [ -z "$OUTPUT" ]; then
    print_error "Fused model inference produced no output"
    exit 1
fi

print_status "✓ Fused model inference successful"
print_status "Sample output (first 200 chars): ${OUTPUT:0:200}..."

# Test 6: Test model-card command
print_status "Test 6: Testing model-card command..."
src/tools/bizarro/tuner.py model-card "$FUSED_MODEL" > /dev/null
print_status "✓ Model card command successful"

# Test 7: Test chat mode (non-interactive)
print_status "Test 7: Testing chat mode..."
echo -e "What is 2+2?\nexit" | src/tools/bizarro/bizarro.py chat --model "$BASE_MODEL" --no-stats > /dev/null 2>&1
print_status "✓ Chat mode test successful"

# Test 8: Test with tools enabled
print_status "Test 8: Testing chat with tools..."
echo -e "What time is it?\nexit" | src/tools/bizarro/bizarro.py chat --model "$BASE_MODEL" --enable-tools --no-stats > /dev/null 2>&1
print_status "✓ Chat with tools test successful"

# Test 9: Run with system prompt
print_status "Test 9: Testing run with system prompt..."
echo "You are a helpful assistant that speaks like a pirate." > "$TEMP_DIR/system.txt"
src/tools/bizarro/bizarro.py run "Tell me about the ocean" \
    --model "$BASE_MODEL" \
    --system "$TEMP_DIR/system.txt" \
    --max-tokens 50 \
    --no-stats > /dev/null
print_status "✓ Run with system prompt successful"

# Test 10: Quantize with different bit sizes
print_status "Test 10: Testing different quantization bit sizes..."
for BITS in 3 8; do
    src/tools/bizarro/tuner.py quantize "$BASE_MODEL" \
        --q-bits $BITS \
        --output-dir "$TEMP_DIR/quantized_${BITS}bit" > /dev/null
    print_status "✓ Quantized to $BITS bits successfully"
done

# Summary
print_status "========================================="
print_status "All tests completed successfully! 🎉"
print_status "========================================="
print_status "Tests performed:"
print_status "  1. Basic run command"
print_status "  2. Model quantization (4-bit)"
print_status "  3. Fine-tuning quantized model"
print_status "  4. Adapter fusion"
print_status "  5. Inference with fused model"
print_status "  6. Model card display"
print_status "  7. Chat mode"
print_status "  8. Chat with tools"
print_status "  9. System prompt"
print_status " 10. Multiple quantization levels"
print_status "========================================="
