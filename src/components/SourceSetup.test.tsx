import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SourceSetup } from "./SourceSetup";

describe("SourceSetup", () => {
  it("explains Codex and provider-neutral setup without implying control", () => {
    render(<SourceSetup onClose={() => undefined} />);

    expect(screen.getByRole("heading", { name: "Connect a local source" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Codex" })).toBeInTheDocument();
    expect(screen.getByText("Any harness · JSON")).toBeInTheDocument();
    expect(screen.getByText("Any harness · JSONL")).toBeInTheDocument();
    expect(screen.getByText("npm run agentarium -- --provider codex")).toBeInTheDocument();
    expect(screen.getByText(/npm run agentarium -- --provider jsonl/)).toBeInTheDocument();
    expect(screen.getByText("npm run agentarium -- --validate /absolute/path/world.json")).toBeInTheDocument();
    expect(screen.getByText("npm run agentarium -- --validate /absolute/path/world.jsonl")).toBeInTheDocument();
    expect(screen.getByText("docs/world-snapshot.schema.json")).toBeInTheDocument();
    expect(screen.getByText(/never sends prompts, commands, approvals, or payloads to a harness/i)).toBeInTheDocument();
    expect(screen.getByText(/then run an adapter command/i)).toBeInTheDocument();
    expect(screen.getAllByText(/replace the example path with the file your bridge writes/i)).toHaveLength(2);
    expect(screen.getByText(/requires Node\.js 24 or newer/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Copy command" })).toHaveLength(3);
    expect(screen.getByRole("group", { name: "Source type" })).toBeInTheDocument();
  });

  it("copies a complete command and closes from the explicit action", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<SourceSetup onClose={onClose} />);

    await user.click(screen.getAllByRole("button", { name: "Copy command" })[0]!);
    expect(writeText).toHaveBeenCalledWith("npm run agentarium -- --provider codex");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close connection guide" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("selects one compact adapter without changing the copied command", async () => {
    const user = userEvent.setup();
    render(<SourceSetup />);

    const jsonlSelector = screen.getByRole("button", { name: "JSONL" });
    expect(jsonlSelector).toHaveAttribute("aria-pressed", "false");
    await user.click(jsonlSelector);
    expect(jsonlSelector).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/--provider jsonl/).closest("article")).toHaveClass("is-selected");
  });
});
