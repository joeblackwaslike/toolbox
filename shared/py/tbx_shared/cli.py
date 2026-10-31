"""Manifest-driven command line parsing for Python tbx tools."""

import re
import sys
import tomllib
import zipfile
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn

import click
from rich.console import Console
from rich.table import Table
from rich.text import Text

from tbx_shared.errors import ExitCode, ToolError
from tbx_shared.output import Output

type OptionValue = str | int | bool
type Manifest = Mapping[str, Any]

BUILTIN_OPTIONS: tuple[dict[str, str], ...] = (
    {"long": "no-input", "short": "y", "summary": "Disable all prompts", "type": "bool"},
    {"long": "json", "summary": "Print machine-readable JSON to stdout", "type": "bool"},
    {"long": "help", "short": "h", "summary": "Show help, as JSON with --json", "type": "bool"},
)
"""Flags every tool gets, in help order; mirrors ``BUILTIN_OPTIONS`` in ``manifest.ts``."""

_INTEGER_PATTERN = re.compile(r"-?(?:0|[1-9][0-9]*)", re.ASCII)
_MAX_SAFE_INTEGER = 9007199254740991
_INTEGER_RULE = (
    "must be an integer from -9007199254740991 to 9007199254740991 in plain ASCII digits"
)
"""What every parser says about a bad ``int`` value; mirrors ``INTEGER_RULE`` in ``manifest.ts``."""
_BUILTIN_NAMES = {"no-input": "no_input", "json": "json_mode", "help": "show_help"}


@dataclass(frozen=True, slots=True)
class ToolContext:
    """What a tool's run function receives once its command line has parsed.

    ``args`` holds the positional arguments that were given, keyed by manifest name. ``opts``
    holds option values keyed by manifest long name; bool options are always present.
    ``interactive`` is true only when stdin is a TTY and neither ``-y``/``--no-input`` nor
    ``--json`` was given.
    """

    args: dict[str, str]
    opts: dict[str, OptionValue]
    json: bool
    interactive: bool
    out: Output


type ToolRun = Callable[[ToolContext], None]


class _Integer(click.ParamType[int]):
    name = "integer"

    def convert(self, value: Any, param: click.Parameter | None, ctx: click.Context | None) -> int:
        if isinstance(value, int):
            return value
        text = str(value)
        if not _INTEGER_PATTERN.fullmatch(text) or abs(int(text)) > _MAX_SAFE_INTEGER:
            self.fail(_INTEGER_RULE, param, ctx)
        return int(text)


def _options(manifest: Manifest) -> list[Mapping[str, Any]]:
    return [*manifest.get("options", []), *BUILTIN_OPTIONS]


def _usage_line(manifest: Manifest) -> str:
    operands = [
        f"<{arg['name']}>" if arg["required"] else f"[{arg['name']}]"
        for arg in manifest.get("args", [])
    ]
    return " ".join([manifest["name"], "[options]", *operands])


def usage_of(manifest: Manifest) -> dict[str, Any]:
    """Build the usage document ``--help --json`` prints; identical to ``usageOf`` in TypeScript."""
    return {
        "name": manifest["name"],
        "alias": manifest.get("alias"),
        "summary": manifest["summary"],
        "version": manifest["version"],
        "usage": _usage_line(manifest),
        "args": [
            {"name": arg["name"], "summary": arg["summary"], "required": arg["required"]}
            for arg in manifest.get("args", [])
        ],
        "options": [
            {
                "long": spec["long"],
                "short": spec.get("short"),
                "summary": spec["summary"],
                "type": spec["type"],
                "default": spec.get("default"),
            }
            for spec in _options(manifest)
        ],
    }


def _click_option(name: str, spec: Mapping[str, Any]) -> click.Option:
    short = [f"-{spec['short']}"] if "short" in spec else []
    decls = [*short, f"--{spec['long']}", name]
    if spec["type"] == "bool":
        return click.Option(decls, is_flag=True, default=spec.get("default", False))
    kind = _Integer() if spec["type"] == "int" else click.STRING
    return click.Option(decls, type=kind, default=spec.get("default"), metavar=spec["long"].upper())


def _print_help(usage: Mapping[str, Any]) -> None:
    console = Console(highlight=False)
    console.print(f"Usage: {usage['usage']}", markup=False)
    console.print()
    console.print(usage["summary"], markup=False)
    console.print()
    table = Table.grid(padding=(0, 2))
    table.add_row(Text("Arguments:", style="bold"))
    for arg in usage["args"]:
        table.add_row(Text(f"  {arg['name']}"), Text(arg["summary"]))
    table.add_row(Text("Options:", style="bold"))
    for spec in usage["options"]:
        short = f"-{spec['short']}, " if spec["short"] else "    "
        value = "" if spec["type"] == "bool" else f" <{spec['long']}>"
        table.add_row(Text(f"  {short}--{spec['long']}{value}"), Text(spec["summary"]))
    console.print(table)


def _write_help(manifest: Manifest, *, json: bool) -> int:
    if json:
        Output(json=True).result(usage_of(manifest))
    else:
        _print_help(usage_of(manifest))
    return ExitCode.OK


def _invoke(run: ToolRun, ctx: ToolContext) -> int:
    try:
        run(ctx)
    except ToolError as error:
        ctx.out.error(f"error: {error}")
        return error.code
    return ExitCode.OK


def _usage_error(manifest: Manifest, message: str, *, json: bool) -> int:
    out = Output(json=json)
    out.error(f"error: {message}")
    out.error(f"Usage: {_usage_line(manifest)}")
    return ExitCode.USAGE


def _stdin_is_tty() -> bool:
    return sys.stdin is not None and sys.stdin.isatty()


def build_command(
    manifest: Manifest, run: ToolRun, *, stdin_tty: bool | None = None
) -> click.Command:
    """Build the real Click command for a manifest; it exits through the Click context.

    ``--help`` wins over a missing argument; ``--help --json`` prints ``usage_of(manifest)``.
    A missing required argument exits ``ExitCode.USAGE`` and never prompts, and a ``ToolError``
    exits with its code, also when the command is mounted in a ``click.Group``. A tool with
    subcommands adds this command and its Typer sub-apps (via ``typer.main.get_command``) to
    one ``click.Group``. That needs ``typer<0.26``, which shares this Click; later Typer
    releases vendor their own Click.

    Args:
        manifest: the parsed ``tool.toml``, already validated by the TypeScript loader.
        run: the tool body; raise ``ToolError`` to pick the exit code.
        stdin_tty: whether stdin is a terminal; checked at call time when ``None``.
    """
    args = list(manifest.get("args", []))
    options = list(manifest.get("options", []))

    def outcome(values: Mapping[str, Any]) -> int:
        json = bool(values["json_mode"])
        if values["show_help"]:
            return _write_help(manifest, json=json)
        given = {
            arg["name"]: values[f"arg_{index}"]
            for index, arg in enumerate(args)
            if values[f"arg_{index}"] is not None
        }
        missing = next((arg for arg in args if arg["required"] and arg["name"] not in given), None)
        if missing is not None:
            message = f"missing required argument '{missing['name']}'"
            return _usage_error(manifest, message, json=json)
        tty = _stdin_is_tty() if stdin_tty is None else stdin_tty
        ctx = ToolContext(
            args=given,
            opts={
                spec["long"]: values[f"opt_{index}"]
                for index, spec in enumerate(options)
                if values[f"opt_{index}"] is not None
            },
            json=json,
            interactive=tty and not values["no_input"] and not json,
            out=Output(json=json),
        )
        return _invoke(run, ctx)

    def callback(**values: Any) -> NoReturn:
        click.get_current_context().exit(outcome(values))

    params: list[click.Parameter] = [
        click.Argument([f"arg_{index}"], required=False, metavar=arg["name"])
        for index, arg in enumerate(args)
    ]
    params += [_click_option(f"opt_{index}", spec) for index, spec in enumerate(options)]
    params += [_click_option(_BUILTIN_NAMES[spec["long"]], spec) for spec in BUILTIN_OPTIONS]
    return click.Command(manifest["name"], params=params, callback=callback, add_help_option=False)


def run_tool(
    manifest: Manifest, run: ToolRun, argv: Sequence[str], *, stdin_tty: bool | None = None
) -> int:
    """Parse ``argv`` against the manifest and call ``run``, returning the exit code.

    Parse errors (unknown flag, bad value, too many or missing arguments) return
    ``ExitCode.USAGE`` with a usage line on stderr.
    """
    command = build_command(manifest, run, stdin_tty=stdin_tty)
    try:
        code = command.main(args=list(argv), prog_name=manifest["name"], standalone_mode=False)
    except click.UsageError as error:
        return _usage_error(manifest, error.format_message(), json="--json" in argv)
    except click.ClickException as error:
        error.show()
        return error.exit_code
    except click.Abort:
        return ExitCode.FAILURE
    return int(code)


def define_tool(manifest: Manifest, run: ToolRun) -> NoReturn:
    """Run a Python tool: parse ``sys.argv`` with ``run_tool`` and exit with its code.

    The command is a real Click command built from the manifest, not a Typer app. Typer
    sub-apps mount next to it in a ``click.Group`` through ``typer.main.get_command``.
    """
    sys.exit(run_tool(manifest, run, sys.argv[1:]))


def load_manifest(entry: str) -> dict[str, Any]:
    """Load the ``tool.toml`` of the tool whose entry module is ``entry`` (pass ``__file__``).

    In the checkout the manifest is ``<tool>/tool.toml``, next to ``src/``. In a built zipapp,
    where ``entry`` lies inside the archive, it is the ``tool.toml`` stored at the archive root,
    so an installed tool never reads the checkout.
    """
    archive = Path(entry).parent
    if zipfile.is_zipfile(archive):
        text = zipfile.Path(archive, "tool.toml").read_text(encoding="utf-8")
    else:
        text = (Path(entry).resolve().parents[1] / "tool.toml").read_text(encoding="utf-8")
    return tomllib.loads(text)
