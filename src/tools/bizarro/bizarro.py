#!/usr/bin/env -S uv run --script
# /// script
# requires-python = "==3.12.*"
# dependencies = [
#     "mlx>=0.26.2",
#     "mlx-lm>=0.25.2",
#     "urllib3==1.26.6",
#     "click>=8.0.0",
#     "rich>=13.0.0",
#     "prompt-toolkit>=3.0.0",
# ]
# ///

# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Standard library imports
import io
import json
import os
import re
import sys
import time
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

# Third-party imports
import click
from prompt_toolkit import PromptSession
from prompt_toolkit.history import FileHistory
from prompt_toolkit.auto_suggest import AutoSuggestFromHistory
from prompt_toolkit.completion import WordCompleter
from prompt_toolkit.styles import Style
from rich.console import Console

# MLX imports
from mlx_lm import load, stream_generate
from mlx_lm.models.cache import load_prompt_cache, make_prompt_cache, save_prompt_cache

# Constants
THINKING_INDICATORS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
INDICATOR_UPDATE_INTERVAL = 0.1
THINKING_INDENT = "        ∘ "
CLEAR_LINE = "\r" + " " * 80 + "\r"
DEFAULT_CONTEXT_LENGTH = 32768

# Global console instance
console = Console()


@dataclass
class StreamState:
    """State management for streaming output"""

    in_thinking: bool = False
    in_tool_call: bool = False
    thinking_buffer: str = ""
    full_response: str = ""
    indicator_idx: int = 0
    last_indicator_time: float = field(default_factory=time.time)
    thinking_indicator_shown: bool = False
    thinking_line_started: bool = False
    first_thinking_char: bool = True
    visible_content_printed: bool = False
    assistant_label_printed: bool = False
    tool_name: Optional[str] = None
    tool_call_buffer: str = ""
    # Statistics tracking
    start_time: float = field(default_factory=time.time)
    first_token_time: Optional[float] = None
    token_count: int = 0


@dataclass
class GenerationStats:
    """Statistics for text generation"""

    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    total_time: float
    time_to_first_token: float
    tokens_per_second: float


@dataclass
class StreamResult:
    """Result from streaming generation"""

    response: str
    tool_calls: List[Dict[str, Any]]
    visible_content_printed: bool
    stats: GenerationStats


@dataclass
class SessionStats:
    """Statistics for a chat session"""

    total_turns: int = 0
    total_prompt_tokens: int = 0
    total_completion_tokens: int = 0
    total_tokens: int = 0
    total_time: float = 0.0
    session_start: float = field(default_factory=time.time)


@dataclass
class RunConfig:
    """Configuration for model run/inference"""

    prompt: str
    model: str = "Qwen/Qwen3-0.6B"
    max_tokens: int = 1000
    system: Optional[str] = None
    context_length: Optional[int] = None
    enable_tools: bool = False
    show_thinking: bool = False
    verbose: bool = False
    print_output: bool = False
    max_kv_size: Optional[int] = None


class ModelError(Exception):
    """Base exception for model-related errors"""

    pass


class ModelLoadError(ModelError):
    """Exception raised when model loading fails"""

    pass


class ToolExecutionError(ModelError):
    """Exception raised when tool execution fails"""

    pass


class PromptError(ModelError):
    """Exception raised for prompt-related issues"""

    pass


def stream_with_thinking_handler(
    model,
    tokenizer,
    prompt,
    max_tokens,
    show_thinking=False,
    tools=None,
    verbose=False,
    print_assistant_label=True,
    prompt_cache=None,
    max_kv_size=None,
    **kwargs,
) -> StreamResult:
    """Stream generation with thinking process handling and tool support

    Args:
        model: The language model
        tokenizer: The tokenizer
        prompt: Input prompt (string or token list)
        max_tokens: Maximum tokens to generate
        show_thinking: Whether to display thinking process
        tools: Available tools dictionary
        verbose: Enable verbose output
        print_assistant_label: Whether to print "Assistant:" label
        prompt_cache: Optional prompt cache
        max_kv_size: Maximum KV cache size
        **kwargs: Additional generation parameters

    Returns:
        StreamResult containing response, tool calls, and statistics
    """
    state = StreamState()

    # Get token count for the prompt
    prompt_tokens = _get_prompt_token_count(prompt, tokenizer)

    # Create cache if not provided
    if prompt_cache is None:
        prompt_cache = make_prompt_cache(model, max_kv_size=max_kv_size)

    for response in stream_generate(
        model,
        tokenizer,
        prompt,
        max_tokens=max_tokens,
        prompt_cache=prompt_cache,
        **kwargs,
    ):
        text = response.text
        state.full_response += text
        state.token_count += 1

        # Track time to first token
        if state.first_token_time is None and text.strip():
            state.first_token_time = time.time()

        i = 0
        while i < len(text):
            char = text[i]

            # Check for tag transitions first
            if text[i:].startswith("<think>"):
                state.in_thinking = True
                state.thinking_buffer = ""
                state.thinking_line_started = False
                state.first_thinking_char = True
                i += 7  # Skip "<think>"

                if (
                    not show_thinking
                    and not state.thinking_indicator_shown
                    and sys.stdout.isatty()
                ):
                    print(
                        f"\r{THINKING_INDICATORS[state.indicator_idx]} Thinking...",
                        end="",
                        flush=True,
                    )
                    state.thinking_indicator_shown = True
                continue

            elif text[i:].startswith("</think>"):
                state.in_thinking = False
                state.thinking_line_started = False
                i += 8  # Skip "</think>"

                if show_thinking and state.thinking_buffer.strip():
                    console.print()  # Final newline after thinking content
                elif state.thinking_indicator_shown and sys.stdout.isatty():
                    print(CLEAR_LINE, end="", flush=True)
                    state.thinking_indicator_shown = False

                state.thinking_buffer = ""
                continue

            elif text[i:].startswith("<tool_call>"):
                state.in_tool_call = True
                state.tool_call_buffer = ""  # Reset buffer for new tool call
                state.tool_name = None  # Reset tool name for new call
                i += 11  # Skip "<tool_call>"

                # Show indicator for tool calls
                if not state.thinking_indicator_shown and sys.stdout.isatty():
                    print(
                        f"\r{THINKING_INDICATORS[state.indicator_idx]} Calling tool...",
                        end="",
                        flush=True,
                    )
                    state.thinking_indicator_shown = True

                if verbose:
                    # Ensure we're on a clean line for tool call output
                    if state.thinking_indicator_shown and sys.stdout.isatty():
                        print(CLEAR_LINE, end="", flush=True)
                        state.thinking_indicator_shown = False
                    print("<tool_call>", end="", flush=True)
                continue

            elif text[i:].startswith("</tool_call>"):
                state.in_tool_call = False
                i += 12  # Skip "</tool_call>"

                # Parse tool name from buffer if we haven't already
                if state.tool_name is None:
                    try:
                        tool_data = json.loads(state.tool_call_buffer.strip())
                        state.tool_name = tool_data.get("name")
                    except (json.JSONDecodeError, AttributeError):
                        pass

                state.tool_call_buffer = ""  # Clear buffer
                state.in_tool_call = False  # Reset tool call state

                # Clear the indicator
                if state.thinking_indicator_shown and sys.stdout.isatty():
                    print(CLEAR_LINE, end="", flush=True)
                    state.thinking_indicator_shown = False

                if verbose:
                    print("</tool_call>", end="", flush=True)
                continue

            # Handle content based on current state
            if state.in_thinking:
                state.thinking_buffer += char
                _handle_thinking_output(state, char, show_thinking)
            elif state.in_tool_call:
                state.tool_call_buffer += char
                # Try to parse tool name if we don't have it yet
                if (
                    state.tool_name is None
                    and "{" in state.tool_call_buffer
                    and "name" in state.tool_call_buffer
                ):
                    try:
                        # Try to parse partial JSON to get tool name early
                        partial = state.tool_call_buffer.strip()
                        if "name" in partial and '"' in partial:
                            # Extract name field value
                            name_match = re.search(r'"name"\s*:\s*"([^"]+)"', partial)
                            if name_match:
                                state.tool_name = name_match.group(1)
                                # Update indicator with tool name
                                if (
                                    state.thinking_indicator_shown
                                    and sys.stdout.isatty()
                                ):
                                    print(
                                        f"\r{THINKING_INDICATORS[state.indicator_idx]} Calling: {state.tool_name}...",
                                        end="",
                                        flush=True,
                                    )
                    except Exception:
                        pass

                if verbose:
                    print(char, end="", flush=True)
            else:
                _handle_normal_output(state, char, print_assistant_label)

            i += 1

    # Final cleanup
    if state.thinking_indicator_shown and sys.stdout.isatty():
        print(CLEAR_LINE, end="", flush=True)

    # Clean response for conversation history (remove thinking tags)
    clean_response = re.sub(
        r"<think>.*?</think>", "", state.full_response, flags=re.DOTALL
    )
    clean_response = clean_response.strip()

    # Handle tool calls if tools are available
    tool_calls = []
    if tools:
        tool_calls = parse_tool_call(state.full_response)
        if tool_calls:
            # Remove tool call XML from clean response
            clean_response = re.sub(
                r"<tool_call>.*?</tool_call>", "", clean_response, flags=re.DOTALL
            ).strip()

    # Calculate statistics
    stats = _calculate_generation_stats(state, prompt_tokens)

    return StreamResult(
        response=clean_response,
        tool_calls=tool_calls,
        visible_content_printed=state.visible_content_printed,
        stats=stats,
    )


def _get_prompt_token_count(prompt, tokenizer) -> int:
    """Get token count for different prompt types"""
    if isinstance(prompt, str):
        try:
            return len(tokenizer.encode(prompt))
        except Exception:
            # Fallback: estimate tokens from string length
            return int(len(prompt.split()) * 1.3)
    elif isinstance(prompt, list):
        return len(prompt)
    else:
        try:
            return len(prompt)
        except Exception:
            return 0


def _calculate_generation_stats(
    state: StreamState, prompt_tokens: int
) -> GenerationStats:
    """Calculate generation statistics"""
    end_time = time.time()
    total_time = end_time - state.start_time
    time_to_first = (
        state.first_token_time - state.start_time if state.first_token_time else 0
    )
    tokens_per_second = state.token_count / total_time if total_time > 0 else 0

    return GenerationStats(
        prompt_tokens=prompt_tokens,
        completion_tokens=state.token_count,
        total_tokens=prompt_tokens + state.token_count,
        total_time=total_time,
        time_to_first_token=time_to_first,
        tokens_per_second=tokens_per_second,
    )


def _handle_thinking_output(state: StreamState, char: str, show_thinking: bool):
    """Handle output when in thinking mode"""
    if show_thinking:
        if char == "\n":
            console.print()
            state.thinking_line_started = False
        elif not char.isspace() or state.thinking_line_started:
            if not state.thinking_line_started:
                if state.first_thinking_char:
                    console.print()  # Newline before first thinking content
                    state.first_thinking_char = False
                console.print(THINKING_INDENT, end="")
                state.thinking_line_started = True
            console.print(f"[dim italic]{char}[/dim italic]", end="")
    else:
        # Only show thinking indicators if we're in a real terminal
        if sys.stdout.isatty():
            # Update thinking indicator periodically
            current_time = time.time()
            if current_time - state.last_indicator_time > INDICATOR_UPDATE_INTERVAL:
                state.indicator_idx = (state.indicator_idx + 1) % len(
                    THINKING_INDICATORS
                )
                # Show appropriate message based on current state
                if state.in_tool_call and state.tool_name:
                    message = f"Calling: {state.tool_name}..."
                elif state.in_tool_call:
                    message = "Calling tool..."
                else:
                    message = "Thinking..."
                print(
                    f"\r{THINKING_INDICATORS[state.indicator_idx]} {message}",
                    end="",
                    flush=True,
                )
                state.last_indicator_time = current_time


def _handle_normal_output(state: StreamState, char: str, print_assistant_label: bool):
    """Handle normal text output"""
    # Clear any remaining thinking indicator only if we're in a terminal
    if state.thinking_indicator_shown and sys.stdout.isatty():
        print(CLEAR_LINE, end="", flush=True)
        state.thinking_indicator_shown = False

    # Print assistant label if needed and this is the first visible content
    if (
        print_assistant_label
        and not state.assistant_label_printed
        and not char.isspace()
    ):
        console.print("[bold magenta]Assistant[/bold magenta]: ", end="")
        state.assistant_label_printed = True
        state.visible_content_printed = True

    # Print the character
    if print_assistant_label:
        # In label mode, only print after label is shown or for non-space chars
        if state.assistant_label_printed or not char.isspace():
            print(char, end="", flush=True)
            if not char.isspace():
                state.visible_content_printed = True
    else:
        # In no-label mode, print everything after first non-space char
        if state.visible_content_printed or not char.isspace():
            print(char, end="", flush=True)
            if not char.isspace():
                state.visible_content_printed = True


def _get_safe_math_context() -> Dict[str, Any]:
    """Get safe mathematical functions for calculator"""
    import math

    return {
        "__builtins__": {},
        "abs": abs,
        "round": round,
        "min": min,
        "max": max,
        "sum": sum,
        "pow": pow,
        "sqrt": math.sqrt,
        "sin": math.sin,
        "cos": math.cos,
        "tan": math.tan,
        "log": math.log,
        "log10": math.log10,
        "exp": math.exp,
        "pi": math.pi,
        "e": math.e,
    }


def calculator(expression: str) -> str:
    """
    Safely evaluate a mathematical expression

    Args:
        expression: A mathematical expression like '2 + 3 * 4' or 'sqrt(16)'

    Returns:
        Calculation result as string

    Raises:
        ToolExecutionError: If expression is unsafe or evaluation fails
    """
    # Basic sanitization
    unsafe_keywords = {"import", "__", "exec", "eval", "open", "file"}
    if any(keyword in expression for keyword in unsafe_keywords):
        raise ToolExecutionError("Expression contains unsafe operations")

    safe_dict = _get_safe_math_context()

    try:
        result = eval(expression, safe_dict, {})
        return str(result)
    except Exception as e:
        raise ToolExecutionError(f"Calculation failed: {str(e)}") from e


def get_current_time(timezone: str = "local") -> str:
    """
    Get the current date and time

    Args:
        timezone: The timezone to use ('local', 'utc')
    """
    if timezone.lower() == "utc":
        now = datetime.utcnow()
        return f"Current UTC time: {now.strftime('%Y-%m-%d %H:%M:%S UTC')}"
    else:
        now = datetime.now()
        return f"Current local time: {now.strftime('%Y-%m-%d %H:%M:%S')}"


def _prepare_conversation(config: RunConfig) -> List[Dict[str, str]]:
    """Prepare conversation history from config"""
    conversation = []

    # Load and add system prompt if provided
    system_prompt = load_system_prompt(config.system)
    if system_prompt:
        conversation.append({"role": "system", "content": system_prompt})

    # Add user prompt
    conversation.append({"role": "user", "content": config.prompt})

    return conversation


def bizarro_run(config: RunConfig) -> str:
    """
    Run the language model with the given configuration

    Args:
        config: Run configuration

    Returns:
        Generated response text

    Raises:
        ModelError: If model operations fail
    """
    # Load the model and tokenizer
    model_obj, tokenizer = load_model_quietly(config.model)

    # Validate context length
    model_max_context = get_model_context_length(model_obj, tokenizer)
    if config.context_length is not None:
        validate_context_length(config.context_length, model_max_context)

    # Get available tools if enabled
    available_tools = get_available_tools() if config.enable_tools else None

    # Prepare conversation
    conversation = _prepare_conversation(config)

    # Create prompt cache for single run
    prompt_cache = make_prompt_cache(model_obj, max_kv_size=config.max_kv_size)

    # Capture output if not printing directly
    output_buffer = None
    original_stdout = None
    if not config.print_output:
        output_buffer = io.StringIO()
        original_stdout = sys.stdout
        sys.stdout = output_buffer

    try:
        # Generate response
        handle_conversation_turn(
            model_obj=model_obj,
            tokenizer=tokenizer,
            conversation=conversation,
            available_tools=available_tools,
            max_tokens=config.max_tokens,
            show_thinking=config.show_thinking,
            verbose=config.verbose,
            print_assistant_label=False,  # Never print "Assistant:" in run mode
            prompt_cache=prompt_cache,
            max_kv_size=config.max_kv_size,
        )

        # Return the response if capturing output
        if not config.print_output:
            sys.stdout = original_stdout

            # Extract the response from conversation
            for msg in reversed(conversation):
                if msg["role"] == "assistant":
                    return msg["content"]

            # Fallback to captured output
            return output_buffer.getvalue().strip()

    finally:
        if not config.print_output and original_stdout:
            sys.stdout = original_stdout


def get_available_tools() -> Dict[str, Callable]:
    """Get the dictionary of available tools"""
    return {
        "calculator": calculator,
        "get_current_time": get_current_time,
    }


def parse_tool_call(response_text: str) -> List[Dict[str, Any]]:
    """Parse tool calls from model response (XML or JSON format)

    Args:
        response_text: Model response text containing tool calls

    Returns:
        List of parsed tool call dictionaries
    """
    tool_calls = []
    patterns = [
        (r"<tool_call>(.*?)</tool_call>", re.DOTALL),
        (r"```json\s*({.*?})\s*```", re.DOTALL),
    ]

    for pattern, flags in patterns:
        matches = re.findall(pattern, response_text, flags)
        for match in matches:
            try:
                tool_call = json.loads(match.strip())
                if isinstance(tool_call, dict) and "name" in tool_call:
                    tool_call.setdefault("arguments", {})
                    tool_calls.append(tool_call)
            except json.JSONDecodeError:
                continue
        if tool_calls:
            break
    return tool_calls


def execute_tool_call(
    tool_call: Dict[str, Any], available_tools: Dict[str, Callable]
) -> str:
    """Execute a tool call and return the result

    Args:
        tool_call: Tool call dictionary with 'name' and 'arguments'
        available_tools: Dictionary of available tool functions

    Returns:
        Tool execution result as string

    Raises:
        ToolExecutionError: If tool execution fails
    """
    tool_name = tool_call.get("name")
    tool_args = tool_call.get("arguments", {})

    if tool_name not in available_tools:
        raise ToolExecutionError(
            f"Tool '{tool_name}' not found. Available tools: {', '.join(available_tools.keys())}"
        )

    try:
        return str(available_tools[tool_name](**tool_args))
    except Exception as e:
        raise ToolExecutionError(f"Error executing {tool_name}: {str(e)}") from e


def _execute_tool_calls(
    tool_calls: List[Dict[str, Any]],
    available_tools: Dict[str, Callable],
    conversation: List[Dict[str, str]],
    verbose: bool,
) -> None:
    """Execute tool calls and add results to conversation

    Args:
        tool_calls: List of tool calls to execute
        available_tools: Available tool functions
        conversation: Conversation history to update
        verbose: Whether to print verbose output
    """
    for tool_call in tool_calls:
        if verbose:
            console.print(f"[dim]Executing tool: {tool_call.get('name')}[/dim]")

        try:
            tool_result = execute_tool_call(tool_call, available_tools)
        except ToolExecutionError as e:
            tool_result = str(e)

        if verbose:
            console.print(f"[green]Tool result: {tool_result}[/green]")

        # Add tool result to conversation
        conversation.append(
            {
                "role": "tool",
                "name": tool_call.get("name"),
                "content": tool_result,
            }
        )


def handle_conversation_turn(
    model_obj,
    tokenizer,
    conversation: List[Dict[str, str]],
    available_tools: Optional[Dict[str, Callable]],
    max_tokens: int,
    show_thinking: bool,
    verbose: bool,
    print_assistant_label: bool = True,
    prompt_cache: Optional[List] = None,
    max_kv_size: Optional[int] = None,
) -> Optional[GenerationStats]:
    """
    Handle a complete conversation turn including tool calls if needed.

    Updates conversation in place and returns statistics.

    Args:
        model_obj: Language model object
        tokenizer: Tokenizer object
        conversation: Conversation history (updated in place)
        available_tools: Available tool functions
        max_tokens: Maximum tokens to generate
        show_thinking: Whether to show thinking process
        verbose: Enable verbose output
        print_assistant_label: Whether to print assistant label
        prompt_cache: Optional prompt cache
        max_kv_size: Maximum KV cache size

    Returns:
        Generation statistics or None
    """
    tools_list = list(available_tools.values()) if available_tools else None

    # Generate the prompt
    if tools_list:
        prompt = tokenizer.apply_chat_template(
            conversation=conversation,
            add_generation_prompt=True,
            tools=tools_list,
        )
    else:
        prompt = tokenizer.apply_chat_template(
            conversation=conversation, add_generation_prompt=True
        )

    # Generate response
    result = stream_with_thinking_handler(
        model=model_obj,
        tokenizer=tokenizer,
        prompt=prompt,
        max_tokens=max_tokens,
        show_thinking=show_thinking,
        tools=available_tools,
        verbose=verbose,
        print_assistant_label=print_assistant_label,
        prompt_cache=prompt_cache,
        max_kv_size=max_kv_size,
    )

    response_text = result.response
    tool_calls = result.tool_calls
    visible_content_printed = result.visible_content_printed
    stats = result.stats

    # Add assistant response to conversation if there's content
    if response_text:
        conversation.append({"role": "assistant", "content": response_text})

    # If content was printed, add newline
    if visible_content_printed:
        print()  # Newline after response

    # Handle tool calls if present
    if tool_calls:
        _execute_tool_calls(tool_calls, available_tools, conversation, verbose)

        # Generate follow-up response after tools
        follow_up_stats = handle_conversation_turn(
            model_obj=model_obj,
            tokenizer=tokenizer,
            conversation=conversation,
            available_tools=available_tools,
            max_tokens=max_tokens,
            show_thinking=show_thinking,
            verbose=verbose,
            print_assistant_label=print_assistant_label,
            prompt_cache=prompt_cache,
            max_kv_size=max_kv_size,
        )
        # Aggregate stats
        if follow_up_stats:
            stats = GenerationStats(
                prompt_tokens=stats.prompt_tokens,
                completion_tokens=stats.completion_tokens
                + follow_up_stats.completion_tokens,
                total_tokens=stats.total_tokens + follow_up_stats.total_tokens,
                total_time=stats.total_time + follow_up_stats.total_time,
                time_to_first_token=stats.time_to_first_token,
                tokens_per_second=(
                    stats.completion_tokens + follow_up_stats.completion_tokens
                )
                / (stats.total_time + follow_up_stats.total_time),
            )

    return stats


def load_system_prompt(system_input: Optional[str]) -> Optional[str]:
    """Load system prompt from string or file

    Args:
        system_input: System prompt string or file path

    Returns:
        System prompt text or None

    Raises:
        PromptError: If file reading fails
    """
    if not system_input:
        return None

    # Try file first, then treat as string
    if os.path.isfile(system_input):
        try:
            with open(system_input, "r", encoding="utf-8") as f:
                return f.read().strip()
        except Exception as e:
            raise PromptError(
                f"Error reading system prompt file '{system_input}': {e}"
            ) from e

    return system_input


def print_generation_stats(stats: GenerationStats, verbose: bool = False):
    """Print generation statistics in a concise format"""
    if not stats:
        return

    # Create a console that outputs to stderr
    err_console = Console(stderr=True)

    # Only print detailed stats if verbose, otherwise just the summary
    if verbose:
        err_console.print("\n[dim]─" * 50 + "[/dim]")
        err_console.print("[bold]Generation Statistics:[/bold]")
        err_console.print(f"[dim]Prompt tokens: {stats.prompt_tokens:,}[/dim]")
        err_console.print(f"[dim]Completion tokens: {stats.completion_tokens:,}[/dim]")
        err_console.print(f"[dim]Total tokens: {stats.total_tokens:,}[/dim]")
        err_console.print(
            f"[dim]Time to first token: {stats.time_to_first_token:.3f}s[/dim]"
        )
        err_console.print(f"[dim]Total time: {stats.total_time:.2f}s[/dim]")
        err_console.print(f"[dim]Tokens/second: {stats.tokens_per_second:.1f}[/dim]")
    else:
        # Concise one-line summary
        err_console.print(
            f"\n[dim]{stats.completion_tokens} tokens in {stats.total_time:.1f}s "
            f"({stats.tokens_per_second:.1f} tokens/s)[/dim]"
        )


def print_chat_session_summary(session_stats: SessionStats):
    """Print a summary of the chat session statistics"""
    session_duration = time.time() - session_stats.session_start

    # Create a console that outputs to stderr
    err_console = Console(stderr=True)

    err_console.print("\n[bold]Chat Session Summary:[/bold]")
    err_console.print("[dim]─" * 50 + "[/dim]")

    # Basic stats
    err_console.print(f"Total turns: {session_stats.total_turns}")
    err_console.print(f"Total prompt tokens: {session_stats.total_prompt_tokens:,}")
    err_console.print(
        f"Total completion tokens: {session_stats.total_completion_tokens:,}"
    )
    err_console.print(f"Total tokens: {session_stats.total_tokens:,}")

    # Time stats
    err_console.print(f"Total generation time: {session_stats.total_time:.1f}s")
    err_console.print(f"Session duration: {session_duration:.1f}s")

    # Average stats
    if session_stats.total_turns > 0:
        avg_completion_tokens = (
            session_stats.total_completion_tokens / session_stats.total_turns
        )
        avg_time_per_turn = session_stats.total_time / session_stats.total_turns
        err_console.print(f"Average tokens/turn: {avg_completion_tokens:.0f}")
        err_console.print(f"Average time/turn: {avg_time_per_turn:.1f}s")

    # Overall performance
    if session_stats.total_time > 0:
        overall_tps = session_stats.total_completion_tokens / session_stats.total_time
        err_console.print(f"Overall tokens/second: {overall_tps:.1f}")

    err_console.print("[dim]─" * 50 + "[/dim]")


def load_model_quietly(model_path: str) -> tuple[Any, Any]:
    """Load model with minimal output

    Args:
        model_path: Path to model (local or HuggingFace)

    Returns:
        Tuple of (model, tokenizer)

    Raises:
        ModelLoadError: If model loading fails
    """
    suppress_output = io.StringIO()
    is_local = os.path.exists(model_path)

    if not is_local:
        print("● Downloading...", end="", flush=True)

    try:
        with redirect_stdout(suppress_output), redirect_stderr(suppress_output):
            result = load(path_or_hf_repo=model_path)
    except Exception as e:
        if not is_local:
            print(f"\r{' ' * 18}\r", end="", flush=True)
        raise ModelLoadError(f"Failed to load model '{model_path}': {str(e)}") from e

    if not is_local:
        print(f"\r{' ' * 18}\r", end="", flush=True)

    return result


def get_model_context_length(model, tokenizer) -> int:
    """Get the maximum context length for a model

    Args:
        model: Language model object
        tokenizer: Tokenizer object

    Returns:
        Maximum context length in tokens
    """
    try:
        # Check model config first - this is usually more accurate
        if hasattr(model, "config"):
            context_keys = [
                "max_position_embeddings",
                "n_positions",
                "max_seq_len",
                "seq_length",
            ]
            for key in context_keys:
                max_context = getattr(model.config, key, None)
                if (
                    max_context
                    and isinstance(max_context, (int, float))
                    and max_context > 0
                ):
                    return int(max_context)

        # Don't use tokenizer.model_max_length as it often reports incorrect values
        # (e.g. 131k for models that actually support 40k)
        return DEFAULT_CONTEXT_LENGTH
    except Exception:
        return DEFAULT_CONTEXT_LENGTH


def validate_context_length(requested_length: int, model_max_length: int) -> None:
    """Validate requested context length against model maximum

    Args:
        requested_length: Requested context length
        model_max_length: Model's maximum context length

    Raises:
        ModelError: If requested length exceeds model maximum
    """
    if requested_length > model_max_length:
        raise ModelError(
            f"Requested context length {requested_length:,} exceeds model's maximum context length of {model_max_length:,}"
        )


@click.group()
@click.option("--system", help="System message (string or file path)")
@click.option("--verbose", is_flag=True, help="Print tokens and timing information")
@click.option("--show-thinking", is_flag=True, help="Show the model's thinking process")
@click.option(
    "--enable-tools", is_flag=True, help="Enable tool support for function calling"
)
@click.option("--no-stats", is_flag=True, help="Disable generation statistics output")
@click.pass_context
def cli(ctx, system, verbose, show_thinking, enable_tools, no_stats):
    """MLX Language Model CLI tool for Qwen3 series models"""
    # Store global options in context for subcommands to access
    ctx.ensure_object(dict)
    ctx.obj["system"] = system
    ctx.obj["verbose"] = verbose
    ctx.obj["show_thinking"] = show_thinking
    ctx.obj["enable_tools"] = enable_tools
    ctx.obj["no_stats"] = no_stats


def _resolve_cli_options(ctx, verbose, show_thinking, system, enable_tools, no_stats):
    """Resolve CLI options from command-specific or global context"""
    return {
        "verbose": verbose if verbose is not None else ctx.obj.get("verbose", False),
        "show_thinking": show_thinking
        if show_thinking is not None
        else ctx.obj.get("show_thinking", False),
        "system": system if system is not None else ctx.obj.get("system"),
        "enable_tools": enable_tools
        if enable_tools is not None
        else ctx.obj.get("enable_tools", False),
        "no_stats": no_stats
        if no_stats is not None
        else ctx.obj.get("no_stats", False),
    }


@cli.command()
@click.argument("prompt", type=str)
@click.option("--model", default="Qwen/Qwen3-0.6B", help="Model to use")
@click.option("--max-tokens", default=1000, help="Maximum number of tokens to generate")
@click.option("--stream", is_flag=True, help="Stream the output")
@click.option(
    "--verbose", is_flag=True, default=None, help="Print tokens and timing information"
)
@click.option(
    "--show-thinking",
    is_flag=True,
    default=None,
    help="Show the model's thinking process",
)
@click.option("--system", default=None, help="System message (string or file path)")
@click.option(
    "--context-length",
    type=int,
    help="Maximum context length to use (defaults to min(16384, model_max))",
)
@click.option(
    "--enable-tools",
    is_flag=True,
    default=None,
    help="Enable tool support for function calling",
)
@click.option(
    "--no-stats",
    is_flag=True,
    default=None,
    help="Disable generation statistics output",
)
@click.option(
    "--max-kv-size",
    type=int,
    default=None,
    help="Maximum size of the key-value cache (limits context window)",
)
@click.pass_context
def run(
    ctx,
    prompt,
    model,
    max_tokens,
    stream,
    verbose,
    show_thinking,
    system,
    context_length,
    enable_tools,
    no_stats,
    max_kv_size,
):
    """Run the language model with the given prompt"""
    # Resolve CLI options
    options = _resolve_cli_options(
        ctx, verbose, show_thinking, system, enable_tools, no_stats
    )

    config = RunConfig(
        prompt=prompt,
        model=model,
        max_tokens=max_tokens,
        system=options["system"],
        context_length=context_length,
        enable_tools=options["enable_tools"],
        show_thinking=options["show_thinking"],
        verbose=options["verbose"],
        print_output=True,
        max_kv_size=max_kv_size,
    )

    try:
        # Load the model and tokenizer
        model_obj, tokenizer = load_model_quietly(config.model)

        model_max_context = get_model_context_length(model_obj, tokenizer)
        if config.context_length is not None:
            validate_context_length(config.context_length, model_max_context)

        # Prepare conversation
        conversation = _prepare_conversation(config)

        # Get available tools if enabled
        available_tools = get_available_tools() if config.enable_tools else None

        # Create prompt cache for single run
        prompt_cache = make_prompt_cache(model_obj, max_kv_size=max_kv_size)

        # Generate response and collect statistics
        stats = handle_conversation_turn(
            model_obj=model_obj,
            tokenizer=tokenizer,
            conversation=conversation,
            available_tools=available_tools,
            max_tokens=config.max_tokens,
            show_thinking=config.show_thinking,
            verbose=config.verbose,
            print_assistant_label=False,  # Don't print "Assistant:" in run mode
            prompt_cache=prompt_cache,
            max_kv_size=max_kv_size,
        )

        # Print statistics unless disabled
        if not options["no_stats"] and stats:
            print_generation_stats(stats, verbose=options["verbose"])

    except ModelError as e:
        raise click.ClickException(str(e))


@cli.command()
@click.option("--model", default="Qwen/Qwen3-0.6B", help="Model to use")
@click.option("--system", default=None, help="System message (string or file path)")
@click.option(
    "--show-thinking",
    is_flag=True,
    default=None,
    help="Show the model's thinking process",
)
@click.option(
    "--verbose", is_flag=True, default=None, help="Show tool execution details"
)
@click.option(
    "--context-length",
    type=int,
    help="Maximum context length to use (defaults to min(16384, model_max))",
)
@click.option(
    "--enable-tools",
    is_flag=True,
    default=None,
    help="Enable tool support for function calling",
)
@click.option(
    "--no-stats",
    is_flag=True,
    default=None,
    help="Disable generation statistics output",
)
@click.option(
    "--enable-cache", is_flag=True, help="Enable prompt caching for faster generation"
)
@click.option(
    "--cache-file",
    type=str,
    default=None,
    help="Path to store prompt cache on disk (implies --enable-cache)",
)
@click.option(
    "--max-kv-size",
    type=int,
    default=None,
    help="Maximum size of the key-value cache (limits context window)",
)
@click.pass_context
def chat(
    ctx,
    model,
    system,
    show_thinking,
    verbose,
    context_length,
    enable_tools,
    no_stats,
    enable_cache,
    cache_file,
    max_kv_size,
):
    """Start an interactive chat session with the model"""
    # Resolve CLI options
    options = _resolve_cli_options(
        ctx, verbose, show_thinking, system, enable_tools, no_stats
    )

    try:
        console.print(f"[bold green]Loading model: {model}[/bold green]")
        model_obj, tokenizer = load_model_quietly(model)
    except ModelError as e:
        raise click.ClickException(str(e))

    # Get model's maximum context length
    model_max_context = get_model_context_length(model_obj, tokenizer)

    # Determine effective context length
    if context_length is None:
        effective_context_length = min(16384, model_max_context)
    else:
        effective_context_length = validate_context_length(
            context_length, model_max_context
        )

    # Build cache status string
    if enable_cache:
        if cache_file:
            cache_status = f"file: {cache_file}"
        else:
            cache_status = "memory"
    else:
        cache_status = "disabled"

    # Build KV cache size info
    if max_kv_size is not None:
        kv_info = f" | KV cache size: {max_kv_size:,}"
    else:
        kv_info = ""

    console.print(
        f"[dim]Using context length: {effective_context_length:,} tokens (model max: {model_max_context:,}) | Cache: {cache_status}{kv_info}[/dim]"
    )

    # Load system prompt if provided
    try:
        system_prompt = load_system_prompt(options["system"])
    except PromptError as e:
        raise click.ClickException(str(e))

    # Get available tools if enabled
    available_tools = get_available_tools() if options["enable_tools"] else None

    # Initialize conversation history
    conversation = []
    if system_prompt:
        conversation.append({"role": "system", "content": system_prompt})
        console.print(f"[dim]System: {system_prompt}[/dim]")

    if options["enable_tools"]:
        console.print(f"[dim]Tools enabled: {', '.join(available_tools.keys())}[/dim]")

    console.print(
        "[bold blue]Chat started! Type 'quit' or 'exit' to end the session.[/bold blue]\n"
    )

    # Initialize session statistics
    session_stats = SessionStats()

    # Initialize prompt cache
    prompt_cache = None
    cache_loaded = False

    # Enable cache if cache_file is specified
    if cache_file:
        enable_cache = True

    # Only initialize cache if enabled
    if enable_cache:
        prompt_cache = []

    # Load cache from file if specified
    if cache_file:
        cache_path = Path(cache_file)
        if cache_path.exists():
            try:
                prompt_cache = load_prompt_cache(str(cache_path))
                cache_loaded = True
                console.print(f"[dim]Loaded prompt cache from {cache_file}[/dim]")
            except Exception as e:
                console.print(
                    f"[yellow]Warning: Could not load cache from {cache_file}: {e}[/yellow]"
                )
        else:
            console.print(f"[dim]Will save prompt cache to {cache_file}[/dim]")

    # Setup prompt_toolkit session with history and auto-suggestions
    history_file = Path.home() / ".bizarro_chat_history"
    session = PromptSession(
        history=FileHistory(str(history_file)),
        auto_suggest=AutoSuggestFromHistory(),
        enable_history_search=True,
        complete_while_typing=True,
        mouse_support=True,
        completer=WordCompleter(
            ["quit", "exit", "clear", "help"]
            + (list(available_tools.keys()) if available_tools else []),
            ignore_case=True,
        ),
        style=Style.from_dict(
            {
                "prompt": "#00aa00 bold",
            }
        ),
    )

    try:
        while True:
            try:
                # Get user input - use simple input() for non-terminals
                if sys.stdin.isatty():
                    user_input = session.prompt(
                        "You: ",
                        multiline=False,
                    )
                else:
                    # Fallback for non-interactive environments
                    print("You: ", end="", flush=True)
                    user_input = input()

                if user_input.lower() in ["quit", "exit"]:
                    break

                # Handle special commands
                if user_input.lower() == "clear":
                    click.clear()
                    continue
                elif user_input.lower() == "help":
                    console.print("[bold]Available commands:[/bold]")
                    console.print("  quit/exit - End the chat session")
                    console.print("  clear - Clear the screen")
                    console.print("  help - Show this help message")
                    if available_tools:
                        console.print(
                            f"\n[bold]Available tools:[/bold] {', '.join(available_tools.keys())}"
                        )
                    console.print(
                        "\n[dim]Use arrow keys to navigate history, Ctrl+R to search[/dim]"
                    )
                    continue

                # Add user message to conversation
                conversation.append({"role": "user", "content": user_input})

                # Create prompt cache if enabled, not loaded from file, and not created yet
                if (
                    enable_cache
                    and not cache_loaded
                    and prompt_cache is not None
                    and not prompt_cache
                ):
                    # Make an empty cache for the model
                    prompt_cache = make_prompt_cache(model_obj, max_kv_size=max_kv_size)

                # Handle the conversation turn
                stats = handle_conversation_turn(
                    model_obj=model_obj,
                    tokenizer=tokenizer,
                    conversation=conversation,
                    available_tools=available_tools,
                    max_tokens=1000,
                    show_thinking=options["show_thinking"],
                    verbose=options["verbose"],
                    print_assistant_label=True,
                    prompt_cache=prompt_cache,
                    max_kv_size=max_kv_size,
                )

                # Update session statistics
                if stats:
                    session_stats.total_turns += 1
                    session_stats.total_prompt_tokens += stats.prompt_tokens
                    session_stats.total_completion_tokens += stats.completion_tokens
                    session_stats.total_tokens += stats.total_tokens
                    session_stats.total_time += stats.total_time

                # Print statistics unless disabled
                if not options["no_stats"] and stats:
                    print_generation_stats(stats, verbose=options["verbose"])

            except KeyboardInterrupt:
                console.print("\n[yellow]Chat interrupted.[/yellow]")
                break
            except Exception as e:
                console.print(f"[red]Error: {e}[/red]")
                continue

    finally:
        # Save cache to file if specified and caching is enabled
        if enable_cache and cache_file and prompt_cache:
            try:
                save_prompt_cache(str(cache_path), prompt_cache)
                console.print(f"\n[dim]Saved prompt cache to {cache_file}[/dim]")
            except Exception as e:
                console.print(
                    f"\n[yellow]Warning: Could not save cache to {cache_file}: {e}[/yellow]"
                )

        # Print session summary
        if not options["no_stats"] and session_stats.total_turns > 0:
            print_chat_session_summary(session_stats)


if __name__ == "__main__":
    cli()
