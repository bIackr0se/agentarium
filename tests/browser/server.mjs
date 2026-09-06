import { main } from "../../bin/agentarium.mjs";
import { sourcePath, writeFixture } from "./fixture.ts";

writeFixture();
await main(["--provider", "json", "--snapshot", sourcePath, "--port", "4176", "--no-open"]);
