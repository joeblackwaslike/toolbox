import json
import subprocess
import sys
import tomllib
from pathlib import Path

import click
import pytest
import typer
from click.testing import CliRunner
from tbx_shared.cli import ToolContext, build_command, run_tool, usage_of
from tbx_shared.errors import ExitCode, ToolError

FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures"
DEMO = FIXTURES / "cli" / "demo_py.py"
MANIFEST = tomllib.loads((FIXTURES / "tools" / "demo" / "tool.toml").read_text(encoding="utf-8"))
GOLDEN = json.loads((FIXTURES / "tools" / "demo" / "usage.json").read_text(encoding="utf-8"))
TIMEOUT_SECONDS = 15


def run_open(*argv: str) -> tuple[int, str, str]:
    """Run the demo with stdin left open as a pipe, failing if it waits for input."""
    with subprocess.Popen(
        [sys.executable, str(DEMO), *argv],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    ) as proc:
        try:
            code = proc.wait(timeout=TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            proc.kill()
            pytest.fail("demo hung waiting for input")
        assert proc.stdout is not None
        assert proc.stderr is not None
        return code, proc.stdout.read(), proc.stderr.read()


def invoke(argv: list[str], *, stdin_tty: bool = False) -> tuple[int, list[ToolContext]]:
    seen: list[ToolContext] = []
    code = run_tool(MANIFEST, seen.append, argv, stdin_tty=stdin_tty)
    return code, seen


def test_exits_2_when_a_required_argument_is_missing_and_y_is_set():
    code, out, err = run_open("-y")
    assert code == ExitCode.USAGE
    assert out == ""
    assert "missing required argument 'src'" in err
    assert "Usage: demo [options] <src> [dest]" in err


def test_json_on_a_non_tty_stdin_prints_valid_json_only_to_stdout():
    code, out, _ = run_open("in.txt", "--json", "-v", "--count", "3")
    assert code == ExitCode.OK
    assert out.endswith("\n")
    assert len(out.strip().splitlines()) == 1
    assert json.loads(out) == {
        "args": {"src": "in.txt"},
        "opts": {"verbose": True, "mode": "fast", "count": 3},
        "json": True,
        "interactive": False,
    }


def test_maps_a_tool_error_to_its_exit_code():
    code, out, err = run_open("fail")
    assert code == ExitCode.CONFIG
    assert out == ""
    assert "failed on purpose" in err


def test_help_json_output_deep_equals_the_manifest_derived_usage(capsys):
    code, seen = invoke(["--help", "--json"])
    assert code == ExitCode.OK
    assert seen == []
    assert json.loads(capsys.readouterr().out) == GOLDEN
    assert usage_of(MANIFEST) == GOLDEN


def test_unknown_flag_exits_2(capsys):
    code, seen = invoke(["in.txt", "--bogus"])
    captured = capsys.readouterr()
    assert code == ExitCode.USAGE
    assert seen == []
    assert captured.out == ""
    assert "Usage: demo" in captured.err


def test_non_integer_int_option_exits_2(capsys):
    code, seen = invoke(["in.txt", "--count", "many"])
    assert code == ExitCode.USAGE
    assert seen == []
    assert capsys.readouterr().out == ""


def test_too_many_arguments_exits_2():
    assert invoke(["a", "b", "c"])[0] == ExitCode.USAGE


def test_human_help_goes_to_stdout_and_exits_0_without_required_arguments(capsys):
    code, seen = invoke(["-h"])
    captured = capsys.readouterr()
    assert code == ExitCode.OK
    assert seen == []
    assert "Usage: demo [options] <src> [dest]" in captured.out
    assert "--no-input" in captured.out
    assert captured.err == ""


def test_parses_arguments_short_forms_defaults_and_equals_values():
    code, seen = invoke(["in.txt", "out.txt", "-m", "slow", "--count=2"])
    assert code == ExitCode.OK
    assert seen[0].args == {"src": "in.txt", "dest": "out.txt"}
    assert seen[0].opts == {"verbose": False, "mode": "slow", "count": 2}
    assert seen[0].json is False


@pytest.mark.parametrize(
    ("argv", "stdin_tty", "expected"),
    [
        (["in.txt"], True, True),
        (["in.txt"], False, False),
        (["in.txt", "-y"], True, False),
        (["in.txt", "--no-input"], True, False),
        (["in.txt", "--json"], True, False),
    ],
)
def test_is_interactive_only_on_a_tty_without_y_or_json(argv, stdin_tty, expected):
    _, seen = invoke(argv, stdin_tty=stdin_tty)
    assert seen[0].interactive is expected


def test_treats_arguments_after_double_dash_as_positionals():
    _, seen = invoke(["--", "--not-a-flag"])
    assert seen[0].args == {"src": "--not-a-flag"}


def test_returns_the_tool_error_code_and_writes_the_message_to_stderr(capsys):
    def fail(_ctx: ToolContext) -> None:
        raise ToolError("nope", ExitCode.UNAVAILABLE)

    assert run_tool(MANIFEST, fail, ["in.txt"], stdin_tty=False) == ExitCode.UNAVAILABLE
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "nope" in captured.err


def mounted_group() -> click.Group:
    """A click.Group holding the manifest command as ``run`` and a Typer sub-app as ``sub``."""
    sub = typer.Typer()

    @sub.command()
    def hello(name: str) -> None:
        print(f"hello {name}")

    @sub.command()
    def bye() -> None:
        print("bye")

    def run(ctx: ToolContext) -> None:
        if ctx.args["src"] == "fail":
            raise ToolError("failed on purpose", ExitCode.CONFIG)

    group = click.Group("demo")
    group.add_command(build_command(MANIFEST, run, stdin_tty=False), "run")
    group.add_command(typer.main.get_command(sub), "sub")
    return group


def test_manifest_command_mounted_in_a_group_exits_with_its_codes():
    runner = CliRunner()
    group = mounted_group()
    missing = runner.invoke(group, ["run", "-y"])
    assert missing.exit_code == ExitCode.USAGE
    assert "missing required argument 'src'" in missing.stderr
    assert runner.invoke(group, ["run", "fail"]).exit_code == ExitCode.CONFIG
    assert runner.invoke(group, ["run", "in.txt"]).exit_code == ExitCode.OK


def test_a_typer_sub_app_mounted_next_to_the_manifest_command_exits_2_on_usage_errors():
    runner = CliRunner()
    group = mounted_group()
    assert runner.invoke(group, ["sub", "hello", "bob"]).output == "hello bob\n"
    for argv in (["sub", "hello"], ["sub", "hello", "bob", "--bogus"]):
        result = runner.invoke(group, argv)
        assert isinstance(result.exception, SystemExit), (argv, result.exception)
        assert result.exit_code == ExitCode.USAGE, argv
