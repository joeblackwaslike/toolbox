import json as jsonlib

from rich.console import Console


class Output:
    """Output channel: results go to stdout, diagnostics to stderr."""

    def __init__(self, *, json: bool) -> None:
        """Create the channel; ``json`` switches ``result`` to plain JSON and disables markup."""
        self._json = json
        self._out = Console(highlight=False)
        self._err = Console(stderr=True, highlight=False)

    def result(self, data: object) -> None:
        """Write the result to stdout, as plain JSON in json mode."""
        if self._json:
            print(jsonlib.dumps(data))
        elif isinstance(data, str):
            self._print_plain(self._out, data)
        else:
            self._print_plain(self._out, jsonlib.dumps(data, indent=2))

    def info(self, message: str) -> None:
        """Write an informational line to stderr."""
        self._write_err(message)

    def error(self, message: str) -> None:
        """Write an error line to stderr."""
        self._write_err(message, style="red")

    def _write_err(self, message: str, style: str | None = None) -> None:
        self._err.print(
            message, markup=False, emoji=False, soft_wrap=True, style=None if self._json else style
        )

    @staticmethod
    def _print_plain(console: Console, text: str) -> None:
        console.print(text, markup=False, emoji=False, soft_wrap=True)
