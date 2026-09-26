import { Check, ChevronRight, Circle, CircleDot, ListTodo, Minus } from "lucide-react";
import type { CSSProperties } from "react";
import { useI18n } from "../../lib/i18n.ts";
import type { TodoItem } from "../../../../shared/protocol.ts";
import { normalizeTodos } from "../../../../shared/todos.ts";
import { useDisclosure } from "../../lib/use-disclosure.ts";
import { Collapsible } from "../Collapsible.tsx";

export function TodoBoard({ partId, items }: { partId: string; items: TodoItem[] }) {
  const t = useI18n();
  const [open, setOpen] = useDisclosure(partId, "plan");
  const steps = normalizeTodos(items);
  if (steps.length === 0) return null;
  const done = steps.filter((item) => item.status === "completed").length;
  const current = steps.find(item => item.status === "in_progress") ?? steps.find(item => item.status === "pending");

  return (
    <section className="todo" aria-label={t("Plan")}>
      <button className="todo-head" type="button" aria-expanded={open} aria-controls={`plan-${partId}`} onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className="group-chevron" aria-hidden="true" />
        <ListTodo size={14} aria-hidden="true" />
        <span>{t("Plan")}</span>
        <span className="todo-progress">{done}/{steps.length}</span>
      </button>
      <Collapsible open={!open && Boolean(current)} className="todo-current-collapse">
        {current && <div className="todo-current"><CircleDot size={14} aria-hidden="true" /><span>{current.text}</span></div>}
      </Collapsible>
      <Collapsible open={open} className="todo-list-collapse">
        <TodoSteps id={`plan-${partId}`} steps={steps} />
      </Collapsible>
    </section>
  );
}

export function TodoSteps({ id, steps }: { id?: string; steps: TodoItem[] }) {
  const t = useI18n();
  return (
    <ul id={id} className="todo-list">
      {steps.map((item, index) => {
        const Icon = item.status === "completed" ? Check : item.status === "in_progress" ? CircleDot : item.status === "cancelled" ? Minus : Circle;
        const label = item.status === "completed" ? t("Completed") : item.status === "in_progress" ? t("In progress") : item.status === "cancelled" ? t("Cancelled") : t("Pending");
        return (
          <li key={`${index}-${item.text}`} className="todo-item" data-status={item.status} style={{ "--todo-step": Math.min(index, 10) } as CSSProperties}>
            <span key={item.status} className="todo-mark" role="img" aria-label={label} title={label}>
              <Icon size={14} aria-hidden="true" />
            </span>
            <span>{item.text}</span>
          </li>
        );
      })}
    </ul>
  );
}
