from enum import IntEnum


class ExitCode(IntEnum):
    """Stable process exit codes shared by every tbx tool."""

    OK = 0
    FAILURE = 1
    USAGE = 2
    UNAVAILABLE = 69
    CONFIG = 78


class ToolError(Exception):
    """Error a tool raises to end the run with a specific exit code."""

    def __init__(self, message: str, code: int = ExitCode.FAILURE) -> None:
        """Store the message and the exit code (default ``ExitCode.FAILURE``)."""
        super().__init__(message)
        self.code = int(code)
