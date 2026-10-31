# transcribe guide

`transcribe <url>` downloads the audio of a video, turns it into text, and prints a cleaned-up markdown version on stdout.

## What it runs

1. `uvx yt-dlp` downloads the best audio as mp3. It tries with Chrome cookies first and retries without them if that fails.
2. `uvx mlx_whisper` transcribes the audio with the `mlx-community/whisper-large-v3-turbo` model. mlx-whisper needs Apple Silicon, so the tool is macOS only.
3. `claude -p` reformats the transcript with a title, headings and paragraph breaks. If the reply is wrapped in one markdown code fence, the fence is removed.

Progress and tool noise go to stderr. Stdout holds only the markdown, so `transcribe <url> > notes.md` works. The temporary work directory is deleted on exit, including after a failure.

## Requirements

`uvx`, `ffmpeg`, `deno` and `claude` must be on PATH. `--json` also needs `jq`. The tool checks for all of them before it downloads anything.

## Output

Plain output is the markdown text. With `--json` the tool prints one object on one line:

```json
{"url": "https://...", "markdown": "# Title\n..."}
```

The transcript is not kept on disk, so the object carries the markdown itself rather than a file path.

## Flags

`-y` and `--no-input` are accepted for consistency with other tools. `transcribe` never prompts, so they change nothing.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The markdown was printed. |
| 1 | The download, the transcription or `claude` failed, or no audio or transcript came out. |
| 2 | Usage error, such as a missing or extra argument. |
| 69 | One of `uvx`, `ffmpeg`, `deno`, `claude` (or `jq` with `--json`) is not installed. |
