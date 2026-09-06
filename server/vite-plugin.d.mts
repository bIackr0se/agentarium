import type { Plugin } from "vite";

declare function agentariumApiPlugin(options?: Record<string, unknown>): Plugin;

export { agentariumApiPlugin };
export default agentariumApiPlugin;
