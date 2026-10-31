_tbx_complete_transcribe() {
  local cur="${COMP_WORDS[COMP_CWORD]}" flag
  COMPREPLY=()
  for flag in -y --no-input --json -h --help; do
    [[ $flag == "$cur"* ]] && COMPREPLY+=("$flag")
  done
}
complete -F _tbx_complete_transcribe transcribe
