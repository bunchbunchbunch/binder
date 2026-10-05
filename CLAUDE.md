# bindertui

## Before every commit: check for secrets and personal information

This repo is public. Before each commit, review everything being committed (`git diff --cached`, including new files) and confirm none of it contains:

- **Secrets:** API keys, tokens, passwords, private keys, `.env` contents, or anything from `~/.config/binder/remote.json` (it holds the gateway's private key).
- **Personal information:** real names, email addresses, home directory paths, employer or client names, account layouts, or machine-specific settings. Personal setup belongs in `~/.config/binder/config.json`, not in code, docs, tests, or fixtures.
- **Unscrubbed fixtures:** `system/init` lines recorded from real runs carry the home path and the full skill, plugin, and MCP server inventory. Rewrite paths to `/Users/me/code/bindertui` (or a `/private/tmp` path) and empty `skills`, `plugins`, and `mcp_servers` before committing.
- **Author identity:** `git config user.email` should be the GitHub noreply address, not a personal one.

A grep over the added lines catches the obvious cases. It does not replace reading the diff.

```sh
git diff --cached -U0 | grep '^+' | grep -Ei 'api[_-]?key|secret|passw(or)?d|bearer|BEGIN [A-Z ]*PRIVATE KEY|sk-ant-|gh[pousr]_[A-Za-z0-9]{20}|xox[abpr]-|AKIA[0-9A-Z]{16}'
git diff --cached -U0 | grep '^+' | grep -E '/Users/|/home/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' | grep -v '/Users/me/'
```

If anything turns up, stop and report it instead of committing.
