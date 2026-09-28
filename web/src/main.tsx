import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist/wght-italic.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";
import "./styles/sidebar.css";
import "./styles/settings.css";
import "./styles/conversation.css";
import "./styles/markdown.css";
import "./styles/diff.css";
import "./styles/composer.css";
import "./styles/inspector.css";
import "./styles/workbench.css";
import "./styles/overlays.css";
import "./styles/git.css";
import "./styles/github.css";
import "./styles/features.css";
import "./styles/virtual-list.css";
import "./styles/computer.css";
import "./styles/environments.css";
import { initializeEnvironment } from "./lib/environment.ts";
import { applyReleaseDefaults } from "./lib/release-defaults.ts";
import { applyCustomColor } from "./lib/custom-theme.ts";
import { followVisualViewport } from "./lib/visual-viewport.ts";

async function start() {
  if (/Mac|iPhone|iPad/.test(navigator.platform)) {
    document.documentElement.style.setProperty(
      "--font-mono", 'Menlo, Monaco, "Courier New", monospace',
    );
  } else if (/Win/.test(navigator.platform)) {
    document.documentElement.style.setProperty(
      "--font-mono", 'Consolas, "Courier New", monospace',
    );
  }
  followVisualViewport();
  await initializeEnvironment();
  applyReleaseDefaults();
  const [{ App }, { connect, logClientError }, { useApp }, { loadSpanish }] = await Promise.all([import("./App.tsx"), import("./lib/socket.ts"), import("./lib/store.ts"), import("./lib/translations.ts")]);
  if (useApp.getState().language === "es") await loadSpanish();

  if (!window.citropyDesktop && window.loomDesktop)
    window.citropyDesktop = window.loomDesktop;

  const { theme, scheme, customColor } = useApp.getState();
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.scheme = scheme;
  applyCustomColor(customColor, scheme);
  document.documentElement.style.setProperty(
    "--ui-scale",
    String(useApp.getState().uiScale / 100),
  );
  connect();
  window.addEventListener("error", (event) => logClientError(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => logClientError(event.reason));

  const root = document.getElementById("root");
  if (!root) throw new Error("missing #root");

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

}

void start().catch(error => {
  const root = document.getElementById("root");
  if (root) root.textContent = error.message;
});
