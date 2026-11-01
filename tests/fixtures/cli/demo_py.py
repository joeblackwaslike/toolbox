import tomllib
from pathlib import Path

from tbx_shared.cli import ToolContext, define_tool
from tbx_shared.errors import ExitCode, ToolError

MANIFEST = tomllib.loads(
    (Path(__file__).parent.parent / "tools" / "demo" / "tool.toml").read_text(encoding="utf-8")
)


def run(ctx: ToolContext) -> None:
    if ctx.args.get("src") == "fail":
        raise ToolError("failed on purpose", ExitCode.CONFIG)
    ctx.out.result(
        {"args": ctx.args, "opts": ctx.opts, "json": ctx.json, "interactive": ctx.interactive}
    )


define_tool(MANIFEST, run)
