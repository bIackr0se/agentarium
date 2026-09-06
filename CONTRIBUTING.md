# Contributing

Agentarium is a localhost-only, read-only map for provider-neutral agent work.
Changes must preserve that boundary.

## Development

Use Node 24 or newer and install from the lockfile:

```bash
npm ci
npm run dev
```

Before opening a pull request, run:

```bash
npm run verify
npm run validate:snapshot -- docs/world-snapshot.example.json
```

## Project boundaries

- Keep the browser and HTTP surface read-only and loopback-only.
- Do not add prompts, approvals, commands, webhooks, or control messages.
- Do not send transcripts, messages, tool payloads, absolute paths, email
  addresses, internal IP addresses, or secrets to the browser.
- Keep Demo records synthetic and label them clearly.
- Update tests and documentation when a contract or user-visible behavior
  changes.
