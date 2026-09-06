# Provider and harness coverage

This matrix separates adapter coverage from contract coverage. The Codex row
is the first real adapter probe. The other named systems are synthetic,
provider-neutral exports that exercise Agentarium's public `WorldSnapshot`
contract. They are not native connectors and do not claim SDK compatibility.

| Source label | Test input | Evidence covered | Defensible claim | Not a claim |
| --- | --- | --- | --- | --- |
| Codex local observer | Temporary SQLite state and history tables, read-only | Real observer open, schema check, parent-child edge, lifecycle event, privacy projection | The current Codex adapter can produce a safe normalized snapshot from the tested schema | Compatibility with every Codex Desktop schema or a live user database |
| Claude Code normalized fixture | `tests/fixtures/providers/claude-code-normalized.json` | JSON provider selection, named project and task, parent-agent preservation, attention state, unknown-field removal | A normalized JSON export with this shape can be consumed without a harness-specific UI path | A native Claude Code integration |
| OpenAI Agents SDK normalized fixture | `tests/fixtures/providers/openai-agents-sdk-normalized.jsonl` | JSONL selection, latest-complete-record recovery, state transition, parent-agent preservation, SSE/API projection | An append-oriented normalized export with this shape can be consumed and recovered after a malformed newest record | A native OpenAI Agents SDK integration |
| Example harness | `docs/world-snapshot.example.json` | Contract validation and provider-neutral provenance | Producers can validate against the documented v1 contract | A production data source |

Every fixture is synthetic and contains no transcript, command output, working
directory, absolute path, secret, or account data. Tests inject hostile fields
separately to verify that the browser-facing projection still removes them.

## Install and launch boundary

The public launcher is the `agentarium` binary from the `agentarium-map`
package. It accepts only explicit `demo`, `codex`, `json`, or `jsonl` providers,
always binds to `127.0.0.1`, and opens only its own loopback URL. JSON and JSONL
paths are resolved locally and never returned by the health or snapshot APIs.

`npm run test:install` builds a tarball, installs it into a separate temporary
project with lifecycle scripts disabled, copies the example snapshot outside
the repository, and starts the installed binary. The test fetches the app shell,
hashed JavaScript, CSS, fonts, health, Live JSON, and Demo JSON before removing
the temporary install. This is the distribution check; a passing source-tree
server test alone is not enough.

Run the focused matrix with:

```bash
node --test tests/provider-matrix.test.mjs
```

The broader provider and observer checks remain available through
`npm run test:node`; the isolated package check is `npm run test:install`.
