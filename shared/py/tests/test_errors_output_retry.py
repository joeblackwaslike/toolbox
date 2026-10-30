import json

import pytest
from tbx_shared.errors import ExitCode, ToolError
from tbx_shared.output import Output
from tbx_shared.retry import retry_policy, with_retry


def test_tool_error_defaults_to_exit_code_1():
    error = ToolError("boom")
    assert error.code == ExitCode.FAILURE == 1
    assert ToolError("x", ExitCode.USAGE).code == 2


def test_result_writes_only_json_to_stdout_when_json_is_true(capsys):
    Output(json=True).result({"a": 1})
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {"a": 1}
    assert captured.err == ""
    assert "\x1b" not in captured.out


def test_info_and_error_never_write_to_stdout(capsys):
    output = Output(json=False)
    output.info("hello")
    output.error("bad")
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "hello" in captured.err
    assert "bad" in captured.err


def test_json_mode_leaves_no_markup_on_stderr(capsys):
    Output(json=True).error("[bold]x[/bold]")
    assert "\x1b" not in capsys.readouterr().err


def flaky(failures: int):
    """Return a callable that raises OSError ``failures`` times, then returns ok."""
    calls = []

    def call() -> str:
        calls.append(1)
        if len(calls) <= failures:
            raise OSError("flaky")
        return "ok"

    call.calls = calls
    return call


def test_retry_policy_retries_a_failing_call_then_succeeds():
    fn = flaky(2)
    assert with_retry(fn, retry_policy(attempts=3, base=0.001))() == "ok"
    assert len(fn.calls) == 3


def test_retry_policy_reraises_the_last_error_after_the_attempt_limit():
    fn = flaky(10)
    with pytest.raises(OSError, match="flaky"):
        with_retry(fn, retry_policy(attempts=3, base=0.001))()
    assert len(fn.calls) == 3


def test_retry_policy_does_not_retry_an_exception_outside_retry_on():
    calls = []

    def boom() -> None:
        calls.append(1)
        raise ValueError("nope")

    with pytest.raises(ValueError, match="nope"):
        with_retry(boom, retry_policy(attempts=3, base=0.001))()
    assert len(calls) == 1
