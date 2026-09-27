import { reportError } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";
import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { onTerminal, send } from "../lib/socket.ts";
import { useApp } from "../lib/store.ts";
import { environmentSignal } from "../lib/environment.ts";
import type { PanelTab } from "../../../shared/workbench.ts";

const DARK = {
  background: "#191919",
  foreground: "#dedede",
  cursor: "#ededed",
  cursorAccent: "#191919",
  selectionBackground: "rgba(255,255,255,0.18)",
  black: "#1e1e1e",
  red: "#f4657a",
  green: "#3ecf8e",
  yellow: "#ffc453",
  blue: "#7d9cff",
  magenta: "#c98bff",
  cyan: "#5fd7d0",
  white: "#c8c8c8",
  brightBlack: "#737373",
  brightRed: "#ff8a9b",
  brightGreen: "#6ee7a8",
  brightYellow: "#ffd479",
  brightBlue: "#9aa8ff",
  brightMagenta: "#dcaaff",
  brightCyan: "#7fe8e2",
  brightWhite: "#f2f2f2",
};

const LIGHT = {
  ...DARK,
  background: "#f0f0f0",
  foreground: "#262626",
  cursor: "#252525",
  cursorAccent: "#f0f0f0",
  selectionBackground: "rgba(0,0,0,0.15)",
  black: "#303030",
  white: "#525252",
  brightBlack: "#8a8a8a",
  brightWhite: "#171717",
  red: "#b4233f",
  green: "#127548",
  yellow: "#906000",
  blue: "#345bcc",
  magenta: "#8d3db2",
  cyan: "#087d82",
  brightRed: "#be244b",
  brightGreen: "#17824a",
  brightYellow: "#966600",
  brightBlue: "#345ed7",
  brightMagenta: "#9645bd",
  brightCyan: "#07808a",
};

function hasWebgl2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2");
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return Boolean(context);
  } catch {
    return false;
  }
}

export function TerminalPane({
  active,
  panel,
}: {
  active: boolean;
  panel: PanelTab;
}) {
  const t = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const renderer = useRef<{ dispose(): void } | null>(null);
  const webgl = useRef<boolean | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const replays = useRef(new WeakMap<Terminal, number>());
  const cursor = useRef<{ offset: number; sessionId: string } | undefined>(undefined);
  const attached = useRef(false);
  const [signal] = useState(environmentSignal);
  const projectId = panel.projectId;
  const connected = useApp((state) => state.connected);
  const scheme = useApp((state) => state.scheme);
  const uiScale = useApp((state) => state.uiScale);

  useEffect(() => {
    if (!connected) attached.current = false;
    if (!active && attached.current) {
      send({ t: "term.unsubscribe", termId: panel.id });
      attached.current = false;
    }
    if (!active || !connected) term.current?.blur();
    if (!active || !connected || !host.current || signal.aborted) return;
    const detach = () => {
      if (attached.current && !signal.aborted) send({ t: "term.unsubscribe", termId: panel.id });
      attached.current = false;
    };
    if (term.current) {
      term.current.options.theme = useApp.getState().scheme === "light" ? LIGHT : DARK;
      term.current.options.fontSize = 13 * useApp.getState().uiScale / 100;
      fit.current?.fit();
      if (!attached.current) {
        attached.current = true;
        send({
          t: "term.open",
          termId: panel.id,
          projectId,
          cols: term.current.cols,
          rows: term.current.rows,
          flowControl: true,
          ...cursor.current,
        });
      }
      if (!document.activeElement?.matches('[role="tab"]:focus-visible')) term.current.focus();
      return detach;
    }
    let disposed = false;

    void (async () => {
      const [{ Terminal: Xterm }, { FitAddon: Fit }, { WebLinksAddon }] =
        await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-web-links"),
        ]);
      if (disposed || signal.aborted || !host.current) return;

      const instance = new Xterm({
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-terminal").trim(),
        fontSize: 13 * useApp.getState().uiScale / 100,
        lineHeight: 1.35,
        letterSpacing: 0,
        cursorBlink: true,
        cursorStyle: "bar",
        allowProposedApi: true,
        scrollback: 8000,
        theme: scheme === "light" ? LIGHT : DARK,
      });
      const fitAddon = new Fit();
      instance.loadAddon(fitAddon);
      instance.loadAddon(new WebLinksAddon());
      instance.open(host.current);
      instance.attachCustomKeyEventHandler(event => {
        if (event.type !== "keydown" || !event.ctrlKey || event.altKey || event.metaKey || event.key.toLowerCase() !== "c" || !instance.hasSelection()) return true;
        event.preventDefault();
        event.stopPropagation();
        try {
          if (!document.execCommand("copy")) {
            if (!navigator.clipboard) throw new Error(t("Could not copy terminal selection. Try your browser's Copy command."));
            void navigator.clipboard.writeText(instance.getSelection()).catch(reportError);
          }
        } catch (error) { reportError(error); }
        return false;
      });

      if (disposed || signal.aborted) {
        instance.dispose();
        return;
      }
      fitAddon.fit();
      term.current = instance;
      fit.current = fitAddon;
      setReady(true);
      attached.current = true;

      send({
        t: "term.open",
        termId: panel.id,
        projectId,
        cols: instance.cols,
        rows: instance.rows,
        flowControl: true,
      });

      instance.onData((data) => {
        if (!signal.aborted && !replays.current.get(instance)) send({ t: "term.data", termId: panel.id, data });
      });
      instance.onResize(({ cols, rows }) => {
        if (!signal.aborted) send({ t: "term.resize", termId: panel.id, cols, rows });
      });
      if (!document.activeElement?.matches('[role="tab"]:focus-visible')) instance.focus();
    })();

    return () => {
      disposed = true;
      detach();
    };
  }, [active, projectId, connected, panel.id]);

  useEffect(() => {
    if (!ready || signal.aborted) return;
    if (!active || !connected) {
      const timer = setTimeout(() => renderer.current?.dispose(), 5000);
      return () => clearTimeout(timer);
    }
    if (renderer.current || webgl.current === false) return;
    let cancelled = false;
    const timer = setTimeout(() => void (async () => {
      webgl.current ??= hasWebgl2();
      if (!webgl.current) return;
      const { WebglAddon } = await import("@xterm/addon-webgl");
      const instance = term.current;
      if (cancelled || signal.aborted || !instance) return;
      const addon = new WebglAddon();
      try {
        instance.loadAddon(addon);
      } catch {
        webgl.current = false;
        addon.dispose();
        return;
      }
      const contexts = [...instance.element!.querySelectorAll("canvas")]
        .map(canvas => canvas.getContext("webgl2")).filter(context => context !== null);
      const release = {
        dispose() {
          if (renderer.current !== release) return;
          renderer.current = null;
          addon.dispose();
          for (const context of contexts) context.getExtension("WEBGL_lose_context")?.loseContext();
        },
      };
      renderer.current = release;
      addon.onContextLoss(() => release.dispose());
      fit.current?.fit();
    })().catch(() => { webgl.current = false; }), 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, connected, ready]);

  useEffect(() => {
    if (!active || !connected) return;
    return onTerminal((event) => {
      if (event.termId !== panel.id || !attached.current) return;
      if (event.t === "term.data") {
        const instance = term.current;
        if (!instance) return;
        const acknowledge = () => {
          if (event.streamId && event.data.length && !signal.aborted)
            send({ t: "term.ack", termId: panel.id, count: event.data.length, streamId: event.streamId });
        };
        const position = event.sessionId && Number.isSafeInteger(event.offset)
          ? { sessionId: event.sessionId, offset: event.offset! } : undefined;
        let data = event.data;
        if (position && !event.reset) {
          const previous = cursor.current;
          if (!previous || previous.sessionId !== position.sessionId || previous.offset < position.offset - data.length || previous.offset >= position.offset) {
            acknowledge();
            return;
          }
          data = data.slice(Math.max(0, previous.offset - (position.offset - data.length)));
        }
        cursor.current = position;
        if (!data && !event.reset) { acknowledge(); return; }
        if (event.reset) replays.current.set(instance, (replays.current.get(instance) ?? 0) + 1);
        instance.write((event.reset ? "\x1bc" : "") + data, () => {
          if (event.reset) replays.current.set(instance, (replays.current.get(instance) ?? 1) - 1);
          if (event.reset && attached.current && !signal.aborted && term.current) {
            if (!document.documentElement.hasAttribute("data-resizing")) fit.current?.fit();
            send({ t: "term.resize", termId: panel.id, cols: term.current.cols, rows: term.current.rows });
          }
          acknowledge();
        });
      }
      else {
        if (event.sessionId && Number.isSafeInteger(event.offset)) {
          const previous = cursor.current;
          const ending = `\r\n[process exited with code ${event.code}]\r\n`;
          if (!previous || previous.sessionId !== event.sessionId || previous.offset !== event.offset! - ending.length) return;
          cursor.current = { sessionId: event.sessionId, offset: event.offset! };
        } else cursor.current = undefined;
        term.current?.writeln(`\r\n${t("[process exited with code {code}]", { code: event.code ?? "?" })}`);
      }
    });
  }, [active, connected, panel.id, t]);

  useEffect(() => {
    if (!active || !term.current) return;
    term.current.options.theme = scheme === "light" ? LIGHT : DARK;
  }, [scheme]);

  useEffect(() => {
    if (!active || !term.current) return;
    term.current.options.fontSize = 13 * uiScale / 100;
    fit.current?.fit();
  }, [uiScale]);

  useEffect(() => {
    if (!active || !connected || !host.current) return;
    let frame = 0;
    const root = document.documentElement;
    const scheduleFit = () => {
      if (frame || root.hasAttribute("data-resizing")) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (root.hasAttribute("data-resizing")) return;
        try {
          fit.current?.fit();
        } catch {
          /* not measurable yet */
        }
      });
    };
    const observer = new ResizeObserver(scheduleFit);
    const dragObserver = new MutationObserver(scheduleFit);
    observer.observe(host.current);
    dragObserver.observe(root, { attributes: true, attributeFilter: ["data-resizing"] });
    return () => {
      observer.disconnect();
      dragObserver.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [active, connected]);

  useEffect(() => {
    return () => {
      if (attached.current && !signal.aborted) send({ t: "term.unsubscribe", termId: panel.id });
      renderer.current?.dispose();
      term.current?.dispose();
      term.current = null;
      cursor.current = undefined;
      fit.current = null;
      attached.current = false;
    };
  }, []);

  return (
    <div className="terminal-pane">
      {!connected && (
        <div className="browser-notice">{t("Reconnecting to your terminal…")}</div>
      )}
      <div className="term" ref={host} />
    </div>
  );
}
