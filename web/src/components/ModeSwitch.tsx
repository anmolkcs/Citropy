import { Code2, MessageCircle } from "lucide-react";
import { useI18n } from "../lib/i18n.ts";
import { setAppMode, useApp } from "../lib/store.ts";
import { ChevronDown } from "./icons.ts";
import { Menu, type MenuItem } from "./Menu.tsx";

export function ModeSwitch() {
  const t = useI18n();
  const mode = useApp((state) => state.appMode);
  const label = mode === "chat" ? t("Chat") : t("Code");
  const items: MenuItem[] = [
    { id: "code", label: t("Code"), hint: t("Projects, Git, shells, and tools"), icon: <Code2 size={17} />, selected: mode === "code", onSelect: () => setAppMode("code") },
    { id: "chat", label: t("Chat"), hint: t("Conversations with the browser and read-only files"), icon: <MessageCircle size={17} />, selected: mode === "chat", onSelect: () => setAppMode("chat") },
  ];
  return <Menu align="start" className="mode-menu" width={300} items={items}
    trigger={({ toggle, id, open }) => <button id={id} type="button" className="mode-select"
      aria-label={t("Switch mode, {mode}", { mode: label })} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
      {label}
      <ChevronDown size={13} />
    </button>}
  />;
}
