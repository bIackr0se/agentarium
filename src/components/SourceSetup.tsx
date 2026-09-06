import { useId, useState } from "react";

export interface SourceConnectionOption {
  id?: "codex" | "json" | "jsonl";
  label: string;
  description: string;
  command: string;
  validationCommand?: string;
}

export const SOURCE_CONNECTION_OPTIONS: readonly SourceConnectionOption[] = [
  {
    id: "codex",
    label: "Codex",
    description: "Reads the tested local Codex state. Run this from your built Agentarium checkout. Requires Node.js 24 or newer.",
    command: "npm run agentarium -- --provider codex",
  },
  {
    id: "json",
    label: "Any harness · JSON",
    description: "For any harness that writes one complete WorldSnapshot JSON file. Replace the example path with the file your bridge writes.",
    command: "npm run agentarium -- --provider json --snapshot /absolute/path/world.json",
    validationCommand: "npm run agentarium -- --validate /absolute/path/world.json",
  },
  {
    id: "jsonl",
    label: "Any harness · JSONL",
    description: "For any harness that appends one complete WorldSnapshot per line. Replace the example path with the file your bridge writes.",
    command: "npm run agentarium -- --provider jsonl --snapshot /absolute/path/world.jsonl",
    validationCommand: "npm run agentarium -- --validate /absolute/path/world.jsonl",
  },
] as const;

export const SOURCE_CONTRACT_NOTE = "JSON and JSONL cards include the matching validator command.";

async function copyCommand(command: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
  await navigator.clipboard.writeText(command);
}

export function SourceSetup({ onClose, options = SOURCE_CONNECTION_OPTIONS, contractNote = SOURCE_CONTRACT_NOTE }: {
  onClose?: () => void;
  options?: readonly SourceConnectionOption[];
  contractNote?: string;
}) {
  const titleId = useId();
  const [selectedAdapter, setSelectedAdapter] = useState(options[0]?.id ?? options[0]?.label ?? "codex");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = async (option: SourceConnectionOption) => {
    try {
      await copyCommand(option.command);
      setCopiedId(option.id ?? option.label);
      setCopyState("copied");
    } catch {
      setCopiedId(option.id ?? option.label);
      setCopyState("failed");
    }
  };

  return (
    <section className="connection-guide" aria-labelledby={titleId}>
      <div className="connection-guide__intro">
        <p className="eyebrow">LOCAL SOURCE</p>
        <h2 id={titleId}>Connect a local source</h2>
        <p>From your Agentarium checkout, run <code>npm ci</code> once to install and build. Then run an adapter command and choose <strong>Live</strong>. The source label and agent count confirm the connection. Agentarium only reads normalized local state. It never sends prompts, commands, approvals, or payloads to a harness.</p>
      </div>

      <ol className="connection-guide__steps" aria-label="Connection steps">
        <li><span>1</span><strong>Choose an adapter</strong></li>
        <li><span>2</span><strong>Run it locally</strong></li>
        <li><span>3</span><strong>Select Live</strong></li>
      </ol>

      <div className="connection-guide__adapter-tabs" role="group" aria-label="Source type">
        {options.map((option) => {
          const optionId = option.id ?? option.label;
          const selectorLabel = option.id === "codex" ? "Codex" : option.id?.toUpperCase() ?? option.label;
          return (
            <button
              type="button"
              key={optionId}
              className={selectedAdapter === optionId ? "is-selected" : ""}
              aria-pressed={selectedAdapter === optionId}
              onClick={() => setSelectedAdapter(optionId)}
            >
              {selectorLabel}
            </button>
          );
        })}
      </div>

      <div className="connection-guide__adapters">
        {options.map((option) => {
          const optionId = option.id ?? option.label;
          const currentState = copiedId === optionId ? copyState : "idle";
          return (
            <article className={`connection-adapter${selectedAdapter === optionId ? " is-selected" : ""}`} key={optionId} data-source-adapter={option.id ?? "custom"}>
              <div>
                <h3>{option.label}</h3>
                <p>{option.description}</p>
              </div>
              <div className="connection-adapter__commands">
                <pre><code>{option.command}</code></pre>
                {option.validationCommand ? (
                  <p className="connection-adapter__validator"><strong>Validate first</strong><code>{option.validationCommand}</code></p>
                ) : null}
              </div>
              <button type="button" onClick={() => void handleCopy(option)}>
                {currentState === "copied" ? "Copied" : currentState === "failed" ? "Copy unavailable" : "Copy command"}
              </button>
            </article>
          );
        })}
      </div>

      <div className="connection-guide__contract">
        <strong>Provider-neutral contract</strong>
        <code>docs/world-snapshot.schema.json</code>
        <span>{contractNote}</span>
        <small>Codex is the tested built-in adapter. Other harnesses connect through the JSON or JSONL bridge, so Agentarium never has to inspect their private internals. A failed adapter stays in the setup state instead of displaying guessed records.</small>
      </div>

      {onClose ? <button type="button" className="connection-guide__close" onClick={onClose} aria-label="Close connection guide">Close</button> : null}
    </section>
  );
}
