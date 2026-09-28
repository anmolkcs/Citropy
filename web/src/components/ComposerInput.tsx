import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { BookOpen, TerminalSquare, Folder, FileText } from "lucide-react";
import { contextReference } from "../../../shared/context.ts";
import type { ThreadMeta } from "../../../shared/protocol.ts";
import type { ProviderCommand, SkillInfo } from "../../../shared/features.ts";
import { api } from "../lib/api.ts";
import { providerLabels } from "../lib/format.ts";
import { scaled, useApp } from "../lib/store.ts";
import { useI18n } from "../lib/i18n.ts";

export function ComposerInput({
  value,
  onChange,
  onSubmit,
  onFiles,
  disabled,
  thread,
  commands,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onFiles: (files: File[]) => void;
  disabled: boolean;
  thread: ThreadMeta;
  commands: Array<{ id: string; label: string; hint: string; icon: ReactNode }>;
}) {
  const t = useI18n();
  const box = useRef<HTMLTextAreaElement>(null);
  const highlights = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const [caret, setCaret] = useState(value.length);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<string>();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [paths, setPaths] = useState<Array<{ path: string; dir: boolean }>>([]);
  const [nativeCommands, setNativeCommands] = useState<ProviderCommand[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const connected = useApp((state) => state.connected);
  const chat = useApp((state) => state.appMode === "chat");
  const mention = /(?:^|\s)@([^\s\[\]]*)$/.exec(value.slice(0, caret));
  const slash = /^\/[\w.:-]*$/.test(value) ? value : undefined;
  const query = mention ? `@${mention[1]}` : slash;
  const mode = mention ? "skills" : slash ? "commands" : undefined;
  const hasMentions = /(?:^|\s)@([\w.:-]+)/.test(value);
  const catalogMode = mode === "commands"
    ? "commands"
    : mode === "skills" || hasMentions ? "skills" : undefined;
  useLayoutEffect(() => {
    const node = box.current;
    if (!node || CSS.supports("field-sizing", "content")) return;
    const editor = node.parentElement!;
    editor.style.minHeight = `${editor.offsetHeight}px`;
    node.style.height = "0px";
    node.style.height = `${Math.min(node.scrollHeight, scaled(320))}px`;
    editor.style.minHeight = "";
    if (highlights.current) highlights.current.scrollTop = node.scrollTop;
  }, [value]);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (highlights.current) {
        highlights.current.style.width = `${node.clientWidth}px`;
        highlights.current.scrollTop = node.scrollTop;
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!catalogMode) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setNativeCommands([]);
    const params = new URLSearchParams({
      projectId: thread.projectId,
      threadId: thread.id,
    });
    const readSkills = api<SkillInfo[]>(`skills?${params}`, {
      signal: controller.signal,
    }).then((value) => {
      if (!controller.signal.aborted) setSkills(value);
    });
    const requests =
      catalogMode === "commands"
        ? [
            readSkills,
            api<ProviderCommand[]>(`commands?${params}`, {
              signal: controller.signal,
            }).then((value) => {
              if (!controller.signal.aborted) setNativeCommands(value);
            }),
          ]
        : [readSkills];
    void Promise.all(requests)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [catalogMode, thread.id, thread.provider, thread.projectId]);
  useEffect(() => {
    setSelected(0);
    setDismissed(undefined);
  }, [query]);
  useEffect(() => {
    if (mode !== "skills") { setPaths([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ threadId: thread.id, query: (mention?.[1] ?? "").split("#")[0]! });
      void api<Array<{ path: string; dir: boolean }>>(`threads/context?${params}`, { signal: controller.signal }).then(setPaths).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, mode, thread.id]);
  const enabled = skills
    .filter((skill) => skill.enabled && skill.provider === thread.provider)
    .sort(
      (a, b) => Number(b.scope === "project") - Number(a.scope === "project"),
    )
    .filter(
      (skill, index, entries) =>
        entries.findIndex((entry) => entry.name === skill.name) === index,
    );
  const reserved = new Set([
    ...commands.map((command) => command.label.slice(1)),
    "color",
    "config",
    "clear",
    "rename",
    "__remote-workflow",
    "workflow-launch-exec",
  ]);
  const highlighted: ReactNode[] = [];
  let end = 0;
  for (const match of value.matchAll(/(?:^|\s)@([\w.:-]+)(?![\w./:-])/g)) {
    if (!enabled.some((skill) => skill.name === match[1])) continue;
    const start = match.index + match[0].indexOf("@");
    highlighted.push(value.slice(end, start));
    highlighted.push(
      <mark key={start} className="skill-mention">@{match[1]}</mark>,
    );
    end = match.index + match[0].length;
  }
  highlighted.push(value.slice(end));
  const options =
    mode === "skills"
      ? [...paths.map(entry => ({ id: `context:${entry.path}`, label: `${contextReference(entry.path)}${(mention?.[1] ?? "").match(/#L\d+(?:-L?\d+)?$/)?.[0] ?? ""}`, hint: entry.dir ? t("Folder listing") : t("File context · add #L10-L20 for specific lines"), icon: entry.dir ? <Folder size={16} /> : <FileText size={16} /> })), ...enabled
          .filter((skill) =>
            skill.name
              .toLowerCase()
              .includes((mention?.[1] ?? "").toLowerCase()),
          )
          .map((skill) => ({
            id: skill.id,
            label: `@${skill.name}`,
            hint: `${t(skill.scope)} · ${skill.description || t("Use this skill")}`,
            icon: <BookOpen size={16} />,
          }))]
      : [
          ...commands,
          ...nativeCommands
            .filter(
              (command) =>
                !reserved.has(command.name) &&
                !skills.some(
                  (skill) =>
                    skill.provider === thread.provider &&
                    (skill.name === command.name ||
                      skill.name === command.name.split(":").at(-1)),
                ),
            )
            .map((command) => ({
              id: `provider:${command.name}`,
              label: `/${command.name}`,
              hint: `${providerLabels[thread.provider]} · ${t(command.description)}${command.argumentHint ? ` · ${command.argumentHint}` : ""}`,
              icon: <TerminalSquare size={16} />,
            })),
        ].filter((command) =>
          command.label.toLowerCase().startsWith((slash ?? "").toLowerCase()),
        );
  const visible = Boolean(mode && query !== dismissed);
  const index = Math.min(selected, Math.max(0, options.length - 1));
  const activeOption = options[index];
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [index, query]);
  const choose = (label: string) => {
    const next = mention
      ? value.slice(0, caret - (mention[1] ?? "").length - 1) +
        label +
        " " +
        value.slice(caret)
      : label + " ";
    const position = mention
      ? caret - (mention[1] ?? "").length - 1 + label.length + 1
      : next.length;
    onChange(next);
    setCaret(position);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(position, position);
    });
  };
  return (
    <div className="composer-writing">
      {visible && (
        <div className="composer-suggestions" ref={list}>
          <div className="composer-suggestions-heading">
            {mode === "skills" ? t("Files and skills") : t("Commands")}
            <span>
              {mode === "skills"
                ? providerLabels[thread.provider]
                : t("Citropy & provider")}
            </span>
          </div>
          <div
            className="composer-suggestion-list scroll"
            id="composer-suggestions"
            role="listbox"
            aria-label={mode === "skills" ? t("Files and skills") : t("Commands")}
          >
            {options.map((option, i) => (
              <button
                type="button"
                role="option"
                aria-selected={i === index}
                id={`composer-option-${i}`}
                key={option.id}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option.label)}
              >
                {option.icon}
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.hint}</small>
                </span>
              </button>
            ))}
            {loading && <p role="status">{t(mode === "skills" ? "Loading skills…" : "Loading commands…")}</p>}
            {!options.length && !loading && !error && (
              <p>{t(mode === "skills" ? "No matching skills." : "No matching commands.")}</p>
            )}
            {error && <p role="status">{error}</p>}
          </div>
        </div>
      )}
      <div className="composer-editor" data-highlighted={highlighted.length > 1}>
        <div className="composer-highlights" ref={highlights} aria-hidden="true">
          {highlighted}{"\n"}
        </div>
        <textarea
          ref={box}
          className="composer-input scroll"
          value={value}
          rows={1}
          aria-label={t("Message")}
          aria-autocomplete="list"
          aria-controls={visible ? "composer-suggestions" : undefined}
          aria-activedescendant={
            visible && options.length ? `composer-option-${index}` : undefined
          }
          disabled={disabled}
          placeholder={
            !connected
              ? t("Citropy is reconnecting. Your message will wait…")
              : thread.running
                ? t("Queue a follow-up…")
                : chat
                  ? t("Ask anything…")
                  : t("Ask a question or describe a change…")
          }
          spellCheck={false}
          onScroll={(event) => {
            if (highlights.current)
              highlights.current.scrollTop = event.currentTarget.scrollTop;
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.items)
              .filter((item) => item.kind === "file")
              .map((item) => item.getAsFile())
              .filter((file): file is File => Boolean(file));
            if (files.length) {
              event.preventDefault();
              onFiles(files);
            }
          }}
          onChange={(event) => {
            setCaret(event.target.selectionStart);
            onChange(event.target.value);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || composing.current) return;
            if (visible && event.key === "Escape") {
              event.preventDefault();
              setDismissed(query);
              return;
            }
            if (visible && activeOption) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setSelected(
                  (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    options.length) %
                    options.length,
                );
                return;
              }
              if (
                event.key === "Tab" ||
                (event.key === "Enter" &&
                  !event.shiftKey &&
                  (mode === "skills" || activeOption.label !== value.trim()))
              ) {
                event.preventDefault();
                choose(activeOption.label);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
      </div>
    </div>
  );
}
