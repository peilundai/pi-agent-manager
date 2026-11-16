import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createVsCodeTransport } from "./vscode";

const root = document.getElementById("root");
if (!root)
  throw new Error("Pi Coding Agent for VS Code root element is missing.");

createRoot(root).render(
  <StrictMode>
    <App transport={createVsCodeTransport()} />
  </StrictMode>,
);
