import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/space-grotesk";
import App from "./App";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Agentarium could not find its root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
