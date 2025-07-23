#!/usr/bin/env TOKENIZERS_PARALLELISM=false uv run --script
# /// script
# requires-python = "==3.12.*"
# dependencies = [
#     "mlx>=0.26.2",
#     "mlx-lm>=0.25.2",
#     "click>=8.0.0",
#     "rich>=13.0.0",
# ]
# ///

# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Standard library imports
import glob
import io
import json
import os
import re
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Third-party imports
import click
import mlx.core as mx
import mlx.optimizers as optim
import numpy as np
from rich.console import Console
from rich.table import Table

# MLX imports
from mlx.utils import tree_flatten, tree_unflatten
from mlx_lm import convert, load
from mlx_lm.tuner import TrainingArgs, train
from mlx_lm.tuner.datasets import CacheDataset, load_dataset
from mlx_lm.tuner.utils import (
    dequantize,
    linear_to_lora_layers,
    load_adapters,
)
from mlx_lm.utils import fetch_from_hub, get_model_path, save

# Global console instance
console = Console()


@dataclass
class ModelConfig:
    """Configuration for model parameters"""

    model_type: str = "Unknown"
    architectures: List[str] = field(default_factory=lambda: ["Unknown"])
    vocab_size: int | str = "Unknown"
    hidden_size: int | str = "Unknown"
    num_layers: int | str = "Unknown"
    num_attention_heads: int | str = "Unknown"
    intermediate_size: int | str = "Unknown"
    max_position_embeddings: int | str = "Unknown"
    context_length: int | str = "Unknown"


@dataclass
class ModelInfo:
    """Complete model information"""

    model_path: str
    model_name: Optional[str] = None
    config: ModelConfig = field(default_factory=ModelConfig)
    total_parameters: str = "Unknown"
    model_size_mb: str = "Unknown"
    model_size_gb: str = "Unknown"
    tokenizer_vocab_size: int | str = "Unknown"


@dataclass
class LoRAConfig:
    """Configuration for LoRA parameters"""

    rank: int = 8
    dropout: float = 0.0
    scale: float = 20.0


@dataclass
class TuningConfig:
    """Configuration for model tuning"""

    fine_tune_type: str
    num_layers: int
    batch_size: int
    iters: int
    learning_rate: float
    max_seq_length: int
    seed: int
    lora_parameters: Optional[LoRAConfig] = None


@dataclass
class DatasetArgs:
    """Arguments for dataset loading"""

    data: str
    max_seq_length: int
    seed: int
    train: bool = True
    test: bool = False
    hf_dataset: bool = False
    mask_prompt: bool = False


def load_model_quietly(model_path: str) -> Tuple[Any, Any]:
    """Load model with minimal output"""
    suppress_output = io.StringIO()

    is_local = os.path.exists(model_path)

    if not is_local:
        print("● Downloading...", end="", flush=True)

    with redirect_stdout(suppress_output), redirect_stderr(suppress_output):
        result = load(path_or_hf_repo=model_path)

    if not is_local:
        print(f"\r{' ' * 18}\r", end="", flush=True)

    return result


def _extract_model_name(model_path: str) -> str:
    """Extract clean model name from path or HuggingFace repo"""
    path_obj = Path(model_path)
    if path_obj.exists() or ("/" in model_path and model_path.count("/") != 1):
        model_name = path_obj.name or path_obj.parent.name
    else:
        model_name = model_path.split("/")[-1]
    return re.sub(r"[^\w\-\.]", "_", model_name)


def generate_adapter_path(model_path: str, suffix: Optional[str] = None) -> str:
    """Generate a descriptive adapter path based on model name"""
    clean_name = _extract_model_name(model_path)
    if suffix:
        return f"{clean_name}-{suffix}.data"

    base_pattern = f"{clean_name}-tune*.data"
    existing = glob.glob(base_pattern)
    if not existing:
        return f"{clean_name}-tune001.data"

    numbers = []
    for path in existing:
        match = re.search(rf"{re.escape(clean_name)}-tune(\d+)\.data", path)
        if match:
            numbers.append(int(match.group(1)))

    next_num = max(numbers) + 1 if numbers else 1
    return f"{clean_name}-tune{next_num:03d}.data"


def find_latest_adapter_path(model_path: str) -> Optional[str]:
    """Find the latest adapter path for a given model"""
    clean_name = _extract_model_name(model_path)
    pattern = f"{clean_name}-*.data"
    existing = glob.glob(pattern)
    if not existing:
        return None
    existing.sort(key=os.path.getmtime, reverse=True)
    return existing[0]


class ModelOperationError(Exception):
    """Base exception for model operation errors"""

    pass


class QuantizationError(ModelOperationError):
    """Exception raised during model quantization"""

    pass


class TuningError(ModelOperationError):
    """Exception raised during model tuning"""

    pass


class FusionError(ModelOperationError):
    """Exception raised during model fusion"""

    pass


def quantize_model(
    model_path: str,
    q_bits: int = 4,
    q_group_size: int = 64,
    output_dir: Optional[str] = None,
) -> str:
    """
    Quantize a model to reduce memory usage

    Args:
        model_path: Path to the model to quantize
        q_bits: Number of bits for quantization (3-8)
        q_group_size: Group size for quantization
        output_dir: Optional output directory for quantized model

    Returns:
        Path to the quantized model

    Raises:
        QuantizationError: If quantization fails
    """
    if not output_dir:
        output_dir = f"{model_path}_quantized_{q_bits}bit"

    if not 3 <= q_bits <= 8:
        raise QuantizationError("q_bits must be between 3 and 8")

    try:
        convert(
            model_path,
            quantize=True,
            q_bits=q_bits,
            q_group_size=q_group_size,
            mlx_path=output_dir,
        )
        return output_dir
    except Exception as e:
        raise QuantizationError(f"Failed to quantize model: {str(e)}") from e


def _prepare_model_for_tuning(
    model: Any, config: TuningConfig
) -> Optional[Dict[str, Any]]:
    """
    Prepare model for fine-tuning based on the tuning type

    Returns:
        LoRA parameters dict if using LoRA/DoRA, None otherwise
    """
    model.freeze()

    if config.num_layers > len(model.layers):
        raise TuningError(
            f"Requested {config.num_layers} layers but model only has {len(model.layers)} layers"
        )

    match config.fine_tune_type:
        case "full":
            for layer in model.layers[-max(config.num_layers, 0) :]:
                layer.unfreeze()
            return None
        case "lora" | "dora":
            lora_params_dict = {
                "rank": config.lora_parameters.rank,
                "dropout": config.lora_parameters.dropout,
                "scale": config.lora_parameters.scale,
            }
            linear_to_lora_layers(
                model,
                config.num_layers,
                lora_params_dict,
                use_dora=(config.fine_tune_type == "dora"),
            )
            return lora_params_dict


def _save_adapter_config(adapter_dir: Path, config: TuningConfig) -> None:
    """Save adapter configuration to JSON file"""
    config_dict = {
        "fine_tune_type": config.fine_tune_type,
        "num_layers": config.num_layers,
        "batch_size": config.batch_size,
        "iters": config.iters,
        "learning_rate": config.learning_rate,
        "max_seq_length": config.max_seq_length,
        "seed": config.seed,
    }

    if config.lora_parameters:
        config_dict["lora_parameters"] = {
            "rank": config.lora_parameters.rank,
            "dropout": config.lora_parameters.dropout,
            "scale": config.lora_parameters.scale,
        }

    with open(adapter_dir / "adapter_config.json", "w") as f:
        json.dump(config_dict, f, indent=2)


def tune_model(
    model_path: str,
    data_path: str,
    config: TuningConfig,
    adapter_path: Optional[str] = None,
) -> str:
    """
    Fine-tune a model using LoRA, DoRA, or full fine-tuning

    Args:
        model_path: Path to the base model
        data_path: Path to training data
        config: Tuning configuration
        adapter_path: Optional path for saving adapters

    Returns:
        Path to the saved adapters

    Raises:
        TuningError: If tuning fails
    """
    valid_tune_types = {"lora", "dora", "full"}
    if config.fine_tune_type not in valid_tune_types:
        raise TuningError(f"fine_tune_type must be one of {valid_tune_types}")

    if not adapter_path:
        adapter_path = generate_adapter_path(model_path)

    # Set random seeds
    mx.random.seed(config.seed)
    np.random.seed(config.seed)

    try:
        # Load model and prepare datasets
        model, tokenizer = load_model_quietly(model_path)

        dataset_args = DatasetArgs(
            data=data_path,
            max_seq_length=config.max_seq_length,
            seed=config.seed,
        )
        train_set, valid_set, _ = load_dataset(dataset_args, tokenizer)

        # Prepare model for fine-tuning
        _prepare_model_for_tuning(model, config)

        # Setup adapter directory and save config
        adapter_dir = Path(adapter_path)
        adapter_dir.mkdir(parents=True, exist_ok=True)
        adapter_file = adapter_dir / "adapters.safetensors"
        _save_adapter_config(adapter_dir, config)

        # Setup training
        training_args = TrainingArgs(
            batch_size=config.batch_size,
            iters=config.iters,
            val_batches=25,
            steps_per_report=10,
            steps_per_eval=200,
            steps_per_save=100,
            adapter_file=adapter_file,
            max_seq_length=config.max_seq_length,
            grad_checkpoint=False,
        )

        opt = optim.AdamW(learning_rate=config.learning_rate)

        # Train the model
        train(
            model=model,
            args=training_args,
            optimizer=opt,
            train_dataset=CacheDataset(train_set),
            val_dataset=CacheDataset(valid_set),
        )

        return adapter_path

    except Exception as e:
        raise TuningError(f"Failed to fine-tune model: {str(e)}") from e


def _fuse_adapter_layers(model: Any, de_quantize: bool) -> int:
    """
    Fuse all LoRA/DoRA layers in the model

    Returns:
        Number of layers fused
    """
    fused_linears = [
        (n, m.fuse(de_quantize=de_quantize))
        for n, m in model.named_modules()
        if hasattr(m, "fuse")
    ]

    if fused_linears:
        model.update_modules(tree_unflatten(fused_linears))

    return len(fused_linears)


def fuse_model(
    model_path: str,
    adapter_path: Optional[str] = None,
    save_path: str = "fused_model",
    de_quantize: bool = False,
) -> str:
    """
    Fuse fine-tuned adapters into the base model

    Args:
        model_path: Path to the base model
        adapter_path: Path to adapter weights (auto-detected if None)
        save_path: Path to save the fused model
        de_quantize: Whether to de-quantize the model

    Returns:
        Path to the saved fused model

    Raises:
        FusionError: If fusion fails
    """
    # Auto-detect adapter path if not provided
    if not adapter_path:
        adapter_path = find_latest_adapter_path(model_path)
        if not adapter_path:
            raise FusionError(
                f"No adapter directories found for model {model_path}. "
                "Use adapter_path to specify the adapter location."
            )

    try:
        # Load model with config
        resolved_model_path = get_model_path(model_path)
        model, model_config, tokenizer = fetch_from_hub(resolved_model_path)

        model.freeze()
        model = load_adapters(model, adapter_path)

        # Fuse adapter layers
        num_fused = _fuse_adapter_layers(model, de_quantize)
        if num_fused == 0:
            raise FusionError("No adapter layers found to fuse")

        # De-quantize if requested
        if de_quantize:
            model = dequantize(model)
            model_config.pop("quantization", None)

        # Save the fused model
        save_path_obj = Path(save_path)
        hf_path = model_path if not Path(model_path).exists() else None

        save(
            save_path_obj,
            resolved_model_path,
            model,
            tokenizer,
            model_config,
            hf_repo=hf_path,
            donate_model=False,
        )

        return save_path

    except FusionError:
        raise
    except Exception as e:
        raise FusionError(f"Failed to fuse model: {str(e)}") from e


def _calculate_model_size(model) -> Tuple[int, int]:
    """Calculate total parameters and size in bytes"""
    total_params = 0
    total_size_bytes = 0

    # Get parameters from model
    if hasattr(model, "named_parameters"):
        params_iter = model.named_parameters()
    elif hasattr(model, "parameters"):
        params_iter = [(f"param_{i}", p) for i, p in enumerate(model.parameters())]
    else:
        params_iter = _get_model_params_recursive(model)

    for name, param in params_iter:
        if hasattr(param, "size"):
            param_size = param.size
        elif hasattr(param, "shape"):
            param_size = 1
            for dim in param.shape:
                param_size *= dim
        else:
            continue

        total_params += param_size

        if hasattr(param, "dtype"):
            dtype_bytes = {
                mx.float32: 4,
                mx.float16: 2,
                mx.bfloat16: 2,
                mx.int8: 1,
                mx.uint8: 1,
            }.get(param.dtype, 4)
            total_size_bytes += param_size * dtype_bytes
        else:
            total_size_bytes += param_size * 4

    return total_params, total_size_bytes


def _export_to_gguf(
    model_path: str, gguf_output_path: Path, export_quantized: bool = True
) -> None:
    """
    Export a model to GGUF format

    Args:
        model_path: Path to the model to export
        gguf_output_path: Path to save the GGUF file
        export_quantized: Whether to export quantized weights (not supported)
    """
    console.print("[bold blue]Exporting to GGUF format...[/bold blue]")

    if not export_quantized:
        console.print(
            "[yellow]Note: GGUF export requires de-quantizing the model first[/yellow]"
        )

    try:
        # Load the original model
        resolved_model_path = get_model_path(model_path)
        model, model_config, tokenizer = fetch_from_hub(resolved_model_path)
        model_type = model_config.get("model_type", "unknown")

        if model_type not in ["llama", "mixtral", "mistral"]:
            console.print(
                f"[yellow]Warning: Model type '{model_type}' may not be fully supported for GGUF conversion[/yellow]"
            )

        from mlx_lm.gguf import convert_to_gguf

        # Get weights from the model
        weights = dict(tree_flatten(model.parameters()))

        # Ensure output directory exists
        gguf_output_path.parent.mkdir(parents=True, exist_ok=True)

        convert_to_gguf(
            resolved_model_path, weights, model_config, str(gguf_output_path)
        )
        console.print(f"[green]GGUF model saved to: {gguf_output_path}[/green]")

        if not export_quantized:
            console.print(
                "[dim]Note: The GGUF file contains the original fp16 weights, not the quantized weights[/dim]"
            )
    except ImportError:
        console.print("[red]Error: GGUF export requires additional dependencies[/red]")
    except Exception as e:
        console.print(f"[red]Error during GGUF export: {e}[/red]")


def _export_to_gguf_after_tuning(
    model_path: str, adapter_path: str, fine_tune_type: str, gguf_path: str
) -> None:
    """
    Export model to GGUF after fine-tuning, handling LoRA/DoRA fusion
    """
    console.print("[bold blue]Exporting to GGUF format...[/bold blue]")

    # For LoRA/DoRA, we need to fuse the adapters first
    if fine_tune_type in ["lora", "dora"]:
        console.print(
            "[dim]Note: LoRA/DoRA adapters will be fused before GGUF export[/dim]"
        )

        try:
            # Create a temporary fused model
            temp_fused_path = f"{adapter_path}_fused_for_gguf"
            fuse_model(model_path, adapter_path, temp_fused_path, de_quantize=True)

            # Export the fused model
            _export_to_gguf(temp_fused_path, Path(adapter_path) / gguf_path)

            # Clean up temporary fused model
            import shutil

            shutil.rmtree(temp_fused_path, ignore_errors=True)

            console.print(
                "[dim]Note: The GGUF file contains the fused model weights[/dim]"
            )

        except Exception as e:
            console.print(f"[red]Error during adapter fusion for GGUF: {e}[/red]")
    else:
        # For full fine-tuning, export directly
        _export_to_gguf(model_path, Path(adapter_path) / gguf_path)


def _get_model_params_recursive(obj, prefix: str = "") -> List[Tuple[str, Any]]:
    """Recursively extract model parameters"""
    params = []
    if hasattr(obj, "__dict__"):
        for name, value in obj.__dict__.items():
            if hasattr(value, "shape") and hasattr(value, "size"):
                params.append((f"{prefix}.{name}" if prefix else name, value))
            elif hasattr(value, "__dict__"):
                params.extend(
                    _get_model_params_recursive(
                        value, f"{prefix}.{name}" if prefix else name
                    )
                )
    return params


def _extract_model_config(config) -> ModelConfig:
    """Extract model configuration from config object"""
    # Extract context length using priority order
    context_keys = ["max_position_embeddings", "n_positions", "max_seq_len"]
    context_length = "Unknown"
    for key in context_keys:
        if hasattr(config, key):
            context_length = getattr(config, key)
            break

    return ModelConfig(
        model_type=getattr(config, "model_type", "Unknown"),
        vocab_size=getattr(config, "vocab_size", "Unknown"),
        hidden_size=getattr(config, "hidden_size", "Unknown"),
        num_layers=getattr(config, "num_hidden_layers", "Unknown"),
        num_attention_heads=getattr(config, "num_attention_heads", "Unknown"),
        intermediate_size=getattr(config, "intermediate_size", "Unknown"),
        max_position_embeddings=getattr(config, "max_position_embeddings", "Unknown"),
        context_length=context_length,
    )


def _get_model_directory(model_path: str) -> Optional[Path]:
    """Get the local directory for a model"""
    if os.path.exists(model_path):
        return Path(model_path)

    try:
        from huggingface_hub import snapshot_download

        cache_dir = snapshot_download(model_path, local_files_only=True)
        return Path(cache_dir)
    except Exception:
        return None


def _load_config_from_files(info: ModelInfo, model_dir: Path):
    """Load additional configuration from model files"""
    config_files = {
        "config.json": model_dir / "config.json",
        "tokenizer_config.json": model_dir / "tokenizer_config.json",
        "model_card.md": model_dir / "README.md",
    }

    for file_type, file_path in config_files.items():
        if not file_path.exists():
            continue

        try:
            if file_type == "config.json":
                with open(file_path, "r") as f:
                    config = json.load(f)
                    info.config = _merge_model_config(info.config, config)
            elif file_type == "model_card.md":
                with open(file_path, "r") as f:
                    content = f.read()
                    lines = content.split("\n")
                    for line in lines[:10]:
                        if line.startswith("# "):
                            info.model_name = line[2:].strip()
                            break
        except Exception as e:
            console.print(f"[dim]Could not read {file_path}: {e}[/dim]")


def _merge_model_config(
    existing: ModelConfig, config_dict: Dict[str, Any]
) -> ModelConfig:
    """Merge configuration from JSON into existing ModelConfig"""
    # Try different keys for context length
    context_keys = [
        "max_position_embeddings",
        "n_positions",
        "max_seq_len",
        "seq_length",
    ]
    context_length = existing.context_length
    for key in context_keys:
        if key in config_dict:
            context_length = config_dict[key]
            break

    return ModelConfig(
        model_type=config_dict.get("model_type", existing.model_type),
        architectures=config_dict.get("architectures", existing.architectures),
        vocab_size=config_dict.get("vocab_size", existing.vocab_size),
        hidden_size=config_dict.get("hidden_size", existing.hidden_size),
        num_layers=config_dict.get("num_hidden_layers", existing.num_layers),
        num_attention_heads=config_dict.get(
            "num_attention_heads", existing.num_attention_heads
        ),
        intermediate_size=config_dict.get(
            "intermediate_size", existing.intermediate_size
        ),
        max_position_embeddings=config_dict.get(
            "max_position_embeddings", existing.max_position_embeddings
        ),
        context_length=context_length,
    )


def get_model_info(model_path: str) -> Optional[ModelInfo]:
    """Get information about a model"""
    try:
        # Try to load the model to get basic info
        console.print(f"[dim]Loading model: {model_path}[/dim]")
        model, tokenizer = load_model_quietly(model_path)

        info = ModelInfo(model_path=model_path)

        # Get tokenizer info
        if hasattr(tokenizer, "vocab"):
            info.tokenizer_vocab_size = len(tokenizer.vocab)
        elif hasattr(tokenizer, "get_vocab"):
            info.tokenizer_vocab_size = len(tokenizer.get_vocab())

        # Try to get model parameter count and size
        try:
            total_params, total_size_bytes = _calculate_model_size(model)

            if total_params > 0:
                info.total_parameters = f"{total_params:,}"
                info.model_size_mb = f"{total_size_bytes / (1024 * 1024):.1f} MB"
                info.model_size_gb = f"{total_size_bytes / (1024 * 1024 * 1024):.2f} GB"
        except Exception as e:
            console.print(f"[dim]Error calculating model size: {e}[/dim]")

        # Extract model configuration
        if hasattr(model, "config"):
            info.config = _extract_model_config(model.config)

        # Try to load additional info from files
        model_dir = _get_model_directory(model_path)
        if model_dir:
            _load_config_from_files(info, model_dir)

        return info

    except Exception as e:
        console.print(f"[red]Error loading model: {e}[/red]")
        return None


# CLI commands
@click.group()
def cli():
    """MLX Tuning CLI tool for model quantization, fine-tuning, and fusion"""
    pass


@cli.command()
@click.argument("model_path", type=str)
@click.option(
    "--q-bits", default=4, type=click.IntRange(3, 8), help="Quantization bits (3-8)"
)
@click.option("--q-group-size", default=64, help="Group size for quantization")
@click.option("--output-dir", help="Output directory for quantized model")
@click.option(
    "--export-gguf",
    is_flag=True,
    help="Export model weights in GGUF format (requires de-quantization)",
)
@click.option(
    "--gguf-path",
    type=str,
    default="ggml-model-f16.gguf",
    help="Path to save the exported GGUF format model weights",
)
def quantize(model_path, q_bits, q_group_size, output_dir, export_gguf, gguf_path):
    """Quantize a model to reduce memory usage"""
    click.echo(f"Quantizing {model_path} to {q_bits}-bit...")

    try:
        result_path = quantize_model(model_path, q_bits, q_group_size, output_dir)
        click.echo(f"Successfully quantized model to: {result_path}")
        output_dir = result_path  # Update for GGUF export
    except ModelOperationError as e:
        raise click.ClickException(str(e))

    # Handle GGUF export if requested
    if export_gguf:
        _export_to_gguf(
            model_path, Path(output_dir) / gguf_path, export_quantized=False
        )


@cli.command()
@click.argument("model_path", type=str)
@click.argument("data_path", type=str)
@click.option(
    "--fine-tune-type",
    type=click.Choice(["lora", "dora", "full"]),
    default="lora",
    help="Type of fine-tuning: lora, dora, or full",
)
@click.option(
    "--num-layers",
    type=int,
    default=16,
    help="Number of layers to fine-tune (-1 for all)",
)
@click.option("--batch-size", type=int, default=4, help="Training batch size")
@click.option("--iters", type=int, default=1000, help="Number of training iterations")
@click.option("--learning-rate", type=float, default=1e-5, help="Learning rate")
@click.option(
    "--val-batches",
    type=int,
    default=25,
    help="Number of validation batches (-1 for all)",
)
@click.option(
    "--steps-per-report", type=int, default=10, help="Steps between loss reports"
)
@click.option(
    "--steps-per-eval", type=int, default=200, help="Steps between evaluations"
)
@click.option("--save-every", type=int, default=100, help="Save adapter every N steps")
@click.option(
    "--adapter-path",
    type=str,
    help="Path to save adapters (default: auto-generated from model name)",
)
@click.option(
    "--suffix",
    type=str,
    help="Custom suffix for adapter path (e.g., 'exp1' -> ModelName-exp1.data)",
)
@click.option(
    "--max-seq-length", type=int, default=2048, help="Maximum sequence length"
)
@click.option("--lora-rank", type=int, default=8, help="LoRA rank")
@click.option("--lora-dropout", type=float, default=0.0, help="LoRA dropout")
@click.option("--lora-scale", type=float, default=20.0, help="LoRA scale")
@click.option(
    "--optimizer",
    type=click.Choice(["adam", "adamw"]),
    default="adamw",
    help="Optimizer",
)
@click.option("--seed", type=int, default=0, help="Random seed")
@click.option("--resume-adapter", type=str, help="Path to adapter file to resume from")
@click.option("--test", is_flag=True, help="Run evaluation on test set after training")
@click.option(
    "--test-batches", type=int, default=500, help="Number of test batches (-1 for all)"
)
@click.option("--grad-checkpoint", is_flag=True, help="Use gradient checkpointing")
@click.option(
    "--export-gguf",
    is_flag=True,
    help="Export model weights in GGUF format after tuning",
)
@click.option(
    "--gguf-path",
    type=str,
    default="ggml-model-f16.gguf",
    help="Path to save the exported GGUF format model weights",
)
def tune(
    model_path,
    data_path,
    fine_tune_type,
    num_layers,
    batch_size,
    iters,
    learning_rate,
    val_batches,
    steps_per_report,
    steps_per_eval,
    save_every,
    adapter_path,
    suffix,
    max_seq_length,
    lora_rank,
    lora_dropout,
    lora_scale,
    optimizer,
    seed,
    resume_adapter,
    test,
    test_batches,
    grad_checkpoint,
    export_gguf,
    gguf_path,
):
    """Fine-tune a model using LoRA, DoRA, or full fine-tuning"""
    # Generate adapter path if not provided
    if not adapter_path:
        adapter_path = generate_adapter_path(model_path, suffix)
        console.print(f"[dim]Using adapter path: {adapter_path}[/dim]")

    console.print(f"[bold green]Loading model: {model_path}[/bold green]")
    console.print(f"[bold green]Loading datasets from: {data_path}[/bold green]")

    config = TuningConfig(
        fine_tune_type=fine_tune_type,
        num_layers=num_layers,
        batch_size=batch_size,
        iters=iters,
        learning_rate=learning_rate,
        max_seq_length=max_seq_length,
        seed=seed,
        lora_parameters=LoRAConfig(
            rank=lora_rank,
            dropout=lora_dropout,
            scale=lora_scale,
        ),
    )

    try:
        result_path = tune_model(model_path, data_path, config, adapter_path)
        console.print(
            f"[bold green]Training completed! Adapters saved to: {result_path}[/bold green]"
        )
        adapter_path = result_path  # Update for consistent reference
    except ModelOperationError as e:
        raise click.ClickException(str(e))

    # Handle CLI-specific features that aren't in the core function
    if test or resume_adapter:
        console.print(
            "[yellow]Note: Test evaluation and resume features are not yet supported[/yellow]"
        )

    # Handle GGUF export if requested
    if export_gguf:
        _export_to_gguf_after_tuning(
            model_path, adapter_path, fine_tune_type, gguf_path
        )


@cli.command()
@click.argument("model_path", type=str)
@click.option(
    "--adapter-path",
    type=str,
    help="Path to the trained adapter weights and config (default: auto-detect latest)",
)
@click.option(
    "--save-path", type=str, default="fused_model", help="Path to save the fused model"
)
@click.option("--de-quantize", is_flag=True, help="Generate a de-quantized model")
@click.option("--export-gguf", is_flag=True, help="Export model weights in GGUF format")
@click.option(
    "--gguf-path",
    type=str,
    default="ggml-model-f16.gguf",
    help="Path to save the exported GGUF format model weights",
)
def fuse(model_path, adapter_path, save_path, de_quantize, export_gguf, gguf_path):
    """Fuse fine-tuned adapters into the base model"""
    # Auto-detect adapter path if not provided
    if not adapter_path:
        adapter_path = find_latest_adapter_path(model_path)
        if adapter_path:
            console.print(f"[dim]Auto-detected adapter path: {adapter_path}[/dim]")

    console.print(f"[bold green]Loading pretrained model: {model_path}[/bold green]")

    try:
        result_path = fuse_model(model_path, adapter_path, save_path, de_quantize)
        console.print(
            f"Model fusion completed successfully! Fused model saved to: {result_path}"
        )
    except ModelOperationError as e:
        raise click.ClickException(str(e))

    # Handle GGUF export if requested
    if export_gguf:
        _export_to_gguf(save_path, Path(save_path) / gguf_path)

    # Show summary table
    table = Table(title="Fusion Summary")
    table.add_column("Property", style="cyan")
    table.add_column("Value", style="white")

    table.add_row("Original Model", model_path)
    table.add_row("Adapter Path", adapter_path or "Auto-detected")
    table.add_row("Fused Model Path", save_path)
    table.add_row("De-quantized", "Yes" if de_quantize else "No")
    table.add_row("GGUF Export", "Yes" if export_gguf else "No")

    console.print(table)


@cli.command(name="model-card")
@click.argument("model_path", type=str)
def model_card(model_path):
    """Show detailed information about a model"""

    info = get_model_info(model_path)
    if not info:
        return

    # Create a table for model information
    table = Table(title=f"Model Information: {model_path}")
    table.add_column("Property", style="cyan", no_wrap=True)
    table.add_column("Value", style="white")

    # Add rows with available information
    table.add_row("Model Path", info.model_path)

    if info.model_name:
        table.add_row("Model Name", info.model_name)

    table.add_row("Model Type", str(info.config.model_type))

    if isinstance(info.config.architectures, list):
        arch_str = ", ".join(info.config.architectures)
    else:
        arch_str = str(info.config.architectures)
    table.add_row("Architecture", arch_str)

    table.add_row("Total Parameters", info.total_parameters)
    table.add_row("Model Size (MB)", info.model_size_mb)
    table.add_row("Model Size (GB)", info.model_size_gb)
    table.add_row("Vocabulary Size", str(info.config.vocab_size))
    table.add_row("Tokenizer Vocab Size", str(info.tokenizer_vocab_size))
    table.add_row("Hidden Size", str(info.config.hidden_size))
    table.add_row("Number of Layers", str(info.config.num_layers))
    table.add_row("Attention Heads", str(info.config.num_attention_heads))
    table.add_row("Intermediate Size", str(info.config.intermediate_size))

    if info.config.context_length != "Unknown":
        context_len = info.config.context_length
        if isinstance(context_len, (int, float)):
            if context_len >= 1000:
                context_display = f"{int(context_len):,} tokens"
            else:
                context_display = f"{int(context_len)} tokens"
        else:
            context_display = str(context_len)
        table.add_row("Context Length", context_display)

    console.print(table)


if __name__ == "__main__":
    cli()
