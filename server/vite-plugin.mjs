// Kept as a tiny stable import surface for vite.config.ts.  The implementation
// lives beside the HTTP handler so dev, preview, and production share exactly
// the same localhost and privacy boundary.
export { agentariumApiPlugin as default, agentariumApiPlugin } from "./api.mjs";
