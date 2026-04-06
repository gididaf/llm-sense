# TODO

- [ ] `init` defaults to all 31 AI tools — should only generate configs for tools the user actually uses (or at minimum, ask). `--tools` flag exists but default is "everything"
- [ ] `init` leaves empty dirs (`.aide/`, `.amazonq/`, `.codex/`, etc.) when `writeFile` fails or is interrupted — `mkdir` runs before write with no cleanup on failure
