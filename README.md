# pi-statusline

This Pi extension replaces the TUI footer. It shows the folder, branch, session,
model, context use, provider use or paid cost, and selected service status.

## Install

Run `pi install ~/development/ai/pi-statusline`.

## Files

- `src/index.ts`: connect Pi events, cache, timer, and footer.
- `src/render.ts`: draw two lines without file or network access.
- `src/usage.ts`: read and merge cached usage.
- `src/anthropic.ts`: read Claude usage headers.
- `src/codex.ts`: read Codex usage events and headers.
- `src/statuses.ts`: read OpenViking and Langfuse status.

Run `pnpm install`, then `pnpm run check`.

Design: viking://user/martin/resources/projects/pi-statusline/notes/design.md
