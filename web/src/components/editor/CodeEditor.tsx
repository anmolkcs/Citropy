import { useI18n } from "../../lib/i18n.ts";
import { useEffect, useRef, useState } from "react";
import { useApp, scaled } from "../../lib/store.ts";
import { useReducedMotion } from "../../lib/use-reduced-motion.ts";
import { monaco } from "./monaco.ts";
import { saveDocument, type TextDocument } from "./documents.ts";
import { EditorContextMenu } from "./EditorContextMenu.tsx";

function hexColor(value: string): string {
  const context = document.createElement("canvas").getContext("2d")!;
  context.fillStyle = value;
  const color = context.fillStyle;
  if (color.startsWith("#")) return color;
  const [r, g, b, a = 1] = color.match(/[\d.]+/g)!.map(Number);
  return `#${[r!, g!, b!, Math.round(a * 255)].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

const SURFACES = new Set(["--panel", "--overlay", "--surface", "--raised", "--raised-2"]);

function withAlpha(hex: string, alpha: number): string {
  if (alpha >= 1) return hex;
  return `${hex.slice(0, 7)}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

function themeColors(element: HTMLElement, alpha: number): Record<string, string> {
  const style = getComputedStyle(element);
  const token = (name: string) => SURFACES.has(name)
    ? withAlpha(hexColor(style.getPropertyValue(`${name}-solid`).trim()), name === "--overlay" ? Math.min(1, alpha + 0.12) : alpha)
    : hexColor(style.getPropertyValue(name).trim());
  const clear = "#00000000";
  return {
    "editor.background": token("--canvas"),
    "editorGutter.background": token("--canvas"),
    "editor.lineHighlightBackground": token("--panel"),
    "editor.lineHighlightBorder": clear,
    "editorLineNumber.foreground": token("--text-4"),
    "editorLineNumber.activeForeground": token("--text-2"),
    "editorIndentGuide.background1": token("--line"),
    "editorIndentGuide.activeBackground1": token("--line-strong"),
    "editorWidget.background": token("--overlay"),
    "editorWidget.foreground": token("--text"),
    "editorWidget.border": clear,
    "editorSuggestWidget.background": token("--overlay"),
    "editorSuggestWidget.border": clear,
    "editorSuggestWidget.selectedBackground": token("--raised-2"),
    "editorHoverWidget.background": token("--overlay"),
    "editorHoverWidget.border": clear,
    "input.background": token("--raised"),
    "input.border": clear,
    "focusBorder": clear,
    "list.hoverBackground": token("--raised"),
    "list.activeSelectionBackground": token("--raised-2"),
    "list.focusBackground": token("--raised-2"),
    "scrollbarSlider.background": token("--line-strong"),
    "scrollbarSlider.hoverBackground": token("--line-bright"),
    "scrollbarSlider.activeBackground": token("--line-bright"),
    "widget.shadow": clear,
  };
}

export function CodeEditor({
  document,
  wrap,
  onReady,
}: {
  document: TextDocument;
  wrap: boolean;
  onReady: (editor: monaco.editor.IStandaloneCodeEditor | null) => void;
}) {
  const t = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const current = useRef(document);
  const theme = useApp((state) => state.theme);
  const scheme = useApp((state) => state.scheme);
  const customColor = useApp((state) => state.customColor);
  const clearBackground = useApp((state) => state.stageBackground !== "default");
  const surfaceAlpha = useApp((state) => state.stageBackground === "default" ? 1 : 1 - state.uiTransparency / 100);
  const scale = useApp((state) => state.uiScale);
  const reducedMotion = useReducedMotion();
  const [problems, setProblems] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number }>();

  useEffect(() => {
    if (!container.current) return;
    const editor = monaco.editor.create(container.current, {
      model: null,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: getComputedStyle(container.current).getPropertyValue("--font-mono").trim(),
      fontSize: scaled(13),
      lineHeight: scaled(22),
      padding: { top: 12, bottom: 12 },
      scrollBeyondLastLine: false,
      smoothScrolling: false,
      fixedOverflowWidgets: true,
      accessibilitySupport: "auto",
      renderWhitespace: "selection",
      bracketPairColorization: { enabled: true },
      tabSize: 2,
      ariaLabel: "Code editor",
      contextmenu: false,
      lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off },
      codeLens: false,
      glyphMargin: false,
      stickyScroll: { enabled: false },
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 12,
      showFoldingControls: "mouseover",
      scrollbar: { useShadows: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });
    instance.current = editor;
    onReady(editor);
    const save = editor.addAction({
      id: "citropy.save",
      label: "Save file",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => saveDocument(current.current),
    });
    const context = editor.onContextMenu((event) => {
      event.event.preventDefault();
      setMenu({ x: event.event.posx, y: event.event.posy });
    });
    return () => {
      current.current.view = editor.saveViewState();
      save.dispose();
      context.dispose();
      editor.dispose();
      instance.current = null;
      onReady(null);
    };
  }, [onReady]);

  useEffect(() => {
    const editor = instance.current;
    if (!editor) return;
    if (current.current !== document)
      current.current.view = editor.saveViewState();
    current.current = document;
    editor.setModel(document.model);
    editor.restoreViewState(document.view);
    editor.updateOptions({ ariaLabel: `Code editor: ${document.path}` });
    const refresh = () =>
      setProblems(
        monaco.editor.getModelMarkers({ resource: document.model.uri }).length,
      );
    refresh();
    const listener = monaco.editor.onDidChangeMarkers(refresh);
    editor.focus();
    return () => listener.dispose();
  }, [document]);

  useEffect(() => {
    if (!container.current) return;
    const name = `citropy-${scheme}-${theme}`;
    monaco.editor.defineTheme(name, {
      base: scheme === "light" ? "vs" : "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        ...themeColors(container.current, surfaceAlpha),
        ...(clearBackground ? { "editor.background": "#00000000", "editorGutter.background": "#00000000" } : {}),
      },
    });
    monaco.editor.setTheme(name);
  }, [theme, scheme, customColor, clearBackground, surfaceAlpha]);

  useEffect(() => {
    instance.current?.updateOptions({
      wordWrap: wrap ? "on" : "off",
      fontSize: scaled(13),
      lineHeight: scaled(22),
      readOnly: document.saving,
      smoothScrolling: !reducedMotion,
    });
  }, [wrap, scale, document.saving, reducedMotion]);

  return (
    <>
      <div className="code-editor-surface" ref={container} />
      {problems > 0 && (
        <button
          type="button"
          className="editor-problems"
          onClick={() => instance.current?.trigger("toolbar", "editor.action.marker.nextInFiles", null)}
          title={t("Go to next problem")}
        >
          {t(problems === 1 ? "{count} problem" : "{count} problems", { count: problems })}
        </button>
      )}
      {menu && instance.current && (
        <EditorContextMenu editor={instance.current} x={menu.x} y={menu.y} onClose={() => setMenu(undefined)} />
      )}
    </>
  );
}
