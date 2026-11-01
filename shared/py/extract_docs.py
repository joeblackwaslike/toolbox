"""Print the public symbols and docstrings of Python modules as JSON.

Usage: python -I extract_docs.py <package-dir>

Public means a top-level function or class whose name has no leading underscore, in a
module whose file name has no leading underscore. Output is sorted by module, then symbol.
"""

import ast
import json
import sys
from pathlib import Path


def _signature(node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef) -> str:
    if isinstance(node, ast.ClassDef):
        bases = ", ".join(ast.unparse(base) for base in node.bases)
        return f"class {node.name}({bases})" if bases else f"class {node.name}"
    prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
    returns = f" -> {ast.unparse(node.returns)}" if node.returns else ""
    return f"{prefix} {node.name}({ast.unparse(node.args)}){returns}"


def extract(package_dir: Path) -> list[dict[str, object]]:
    """Return one entry per module with its public symbols, sorted by name."""
    modules: list[dict[str, object]] = []
    for path in sorted(package_dir.glob("[!_]*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        symbols = [
            {
                "name": node.name,
                "signature": _signature(node),
                "doc": ast.get_docstring(node) or "",
            }
            for node in tree.body
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef)
            and not node.name.startswith("_")
        ]
        symbols.sort(key=lambda symbol: str(symbol["name"]))
        if symbols:
            modules.append({"module": path.stem, "symbols": symbols})
    return modules


if __name__ == "__main__":
    sys.stdout.write(json.dumps(extract(Path(sys.argv[1])), indent=2) + "\n")
