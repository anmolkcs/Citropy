import { FlaskConical, GitBranch, MessageCircleQuestion, ShieldQuestion, TerminalSquare, Trash2 } from "lucide-react";
import { Menu } from "./Menu.tsx";
import { clearFakes, fakeGitChanges, fakePermission, fakeQuestion, fakeShell } from "../lib/dev-triggers.ts";
import { useApp } from "../lib/store.ts";

export function DevTriggers() {
  const development = useApp((state) => state.development);
  const hasThread = useApp((state) => Boolean(state.threads[state.activeThreadId ?? ""]));
  if (!development) return null;
  const items = [
    { id: "question", label: "Question", hint: "Two questions in the composer", icon: <MessageCircleQuestion size={16} />, onSelect: fakeQuestion },
    { id: "permission", label: "Permission", hint: "A command waiting for approval", icon: <ShieldQuestion size={16} />, onSelect: fakePermission },
    { id: "shell", label: "Running shell", hint: "Adds to the shells tab", icon: <TerminalSquare size={16} />, onSelect: fakeShell },
    { id: "git", label: "Git changes", hint: "Three changed files on the git tab", icon: <GitBranch size={16} />, onSelect: fakeGitChanges },
    { id: "clear", label: "Clear fakes", hint: "Git refreshes on its own", icon: <Trash2 size={16} />, onSelect: clearFakes },
  ].map((item) => ({ ...item, disabled: !hasThread }));
  return (
    <div className="dev-triggers">
      <Menu
        header="Trigger a fake"
        align="end"
        width={280}
        items={items}
        trigger={({ id, open, toggle }) => (
          <button id={id} type="button" className="dev-triggers-button" aria-label="Development triggers" title="Development triggers" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
            <FlaskConical size={15} />
          </button>
        )}
      />
    </div>
  );
}
