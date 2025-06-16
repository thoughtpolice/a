# Sample Fine-tuning Data

This directory contains sample datasets in various formats supported by MLX-LM for fine-tuning.

## File Formats

### Chat Format (Default)
- `train.jsonl`, `valid.jsonl`, `test.jsonl` - Chat format with system/user/assistant messages
- Best for training conversational models and Q&A systems

Example:
```json
{"messages": [{"role": "system", "content": "You are a helpful assistant."}, {"role": "user", "content": "What is AI?"}, {"role": "assistant", "content": "AI is..."}]}
```

### Completions Format
- `completions_train.jsonl` - Prompt-completion pairs
- Good for specific prompt-response training

Example:
```json
{"prompt": "What is the speed of light?", "completion": "The speed of light is..."}
```

### Text Format
- `text_train.jsonl` - Raw text for language modeling
- Useful for general text generation training

Example:
```json
{"text": "The Theory of Relativity, developed by Albert Einstein..."}
```

## Usage

### Basic fine-tuning with chat format:
```bash
python bizarro.py finetune Qwen/Qwen3-0.6B data/
```

### Using completions format (requires config):
```bash
# Create a config.yaml file specifying the data format
python bizarro.py finetune Qwen/Qwen3-0.6B data/ --config config.yaml
```

### Small test run:
```bash
python bizarro.py finetune Qwen/Qwen3-0.6B data/ \
  --iters 10 \
  --batch-size 1 \
  --num-layers 4
```

## Data Requirements

- **train.jsonl**: Training data (required for --train)
- **valid.jsonl**: Validation data (required for --train)
- **test.jsonl**: Test data (optional, used with --test)

Each line must be a valid JSON object. The format is automatically detected by MLX-LM based on the keys present in the JSON objects.
