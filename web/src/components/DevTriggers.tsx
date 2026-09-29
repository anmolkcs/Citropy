import { Clock3, FlaskConical, GitBranch, Hourglass, MessageCircleQuestion, ShieldQuestion, Sparkles, TerminalSquare, Trash2 } from "lucide-react";
import { Menu } from "./Menu.tsx";
import { clearFakes, fakeGitChanges, fakePermission, fakeQuestion, fakeQueued, fakeShell, fakeUsageLimit, fakeWhatsNew } from "../lib/dev-triggers.ts";
import { reportError } from "../lib/api.ts";
import { send } from "../lib/socket.ts";
import { useApp } from "../lib/store.ts";

export function DevTriggers() {
  const development = useApp((state) => state.development);
  const hasThread = useApp((state) => Boolean(state.threads[state.activeThreadId ?? ""]));
  const usingAppData = useApp((state) => state.usingAppData);
  if (!development) return null;
  const items = [
    { id: "question", label: "Question", hint: "Two questions in the composer", icon: <MessageCircleQuestion size={16} />, onSelect: fakeQuestion },
    { id: "permission", label: "Permission", hint: "A command waiting for approval", icon: <ShieldQuestion size={16} />, onSelect: fakePermission },
    { id: "queued", label: "Queued messages", hint: "Two messages waiting in the queue", icon: <Clock3 size={16} />, onSelect: fakeQueued },
    { id: "usage-limit", label: "Usage limit", hint: "Chat stopped until usage resets", icon: <Hourglass size={16} />, onSelect: fakeUsageLimit },
    { id: "shell", label: "Running shell", hint: "Adds to the shells tab", icon: <TerminalSquare size={16} />, onSelect: fakeShell },
    { id: "git", label: "Git changes", hint: "Three changed files on the git tab", icon: <GitBranch size={16} />, onSelect: fakeGitChanges },
    { id: "clear", label: "Clear fakes", hint: "Git refreshes on its own", icon: <Trash2 size={16} />, onSelect: clearFakes },
  ].map((item) => ({ ...item, disabled: !hasThread }));
  items.splice(-1, 0, { id: "whats-new", label: "What's new", hint: "Release notes shown after an update", icon: <Sparkles size={16} />, onSelect: () => { fakeWhatsNew().catch(reportError); }, disabled: false });
  return (
    <>
      <span className="dev-mark" aria-hidden="true">{usingAppData ? "dev, app chats" : "dev"}</span>
      <div className="dev-triggers">
        <Menu
          header="Trigger a fake"
          align="end"
          width={280}
          items={items}
          footer={
            <label className="dev-data-toggle">
              <span>
                <strong>App chats</strong>
                <small>Load the regular app's chats. Restarts the server.</small>
              </span>
              <input className="setting-switch" type="checkbox" role="switch" checked={usingAppData}
                onChange={(event) => send({ t: "server.useAppData", enabled: event.target.checked })} />
            </label>
          }
          trigger={({ id, open, toggle }) => (
            <button id={id} type="button" className="dev-triggers-button" aria-label="Development triggers" title="Development triggers" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
              <FlaskConical size={15} />
            </button>
          )}
        />
      </div>
    </>
  );
}
