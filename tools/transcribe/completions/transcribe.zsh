#compdef transcribe

_arguments -s \
  '(-y --no-input)'{-y,--no-input}'[Disable all prompts]' \
  '--json[Print machine-readable JSON to stdout]' \
  '(-h --help)'{-h,--help}'[Show help, as JSON with --json]' \
  '*:file:_files'
