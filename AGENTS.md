# Work rules

- Use pnpm. Do not use npm or npx.
- Run `pnpm run check` before you finish.
- Do not add tests or slash commands.
- Use Pi theme names with `theme.fg()` only.
- Use only coding-agent types and pure pi-tui helpers; use the theme from `setFooter`.
- Read provider data only. Do not poll or make network calls.
- Keep rendering pure and no more than two lines.
- Read the design before you change behavior:
  viking://user/martin/resources/projects/pi-statusline/notes/design.md
