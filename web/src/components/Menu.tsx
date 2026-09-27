import { useI18n } from "../lib/i18n.ts";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  Fragment,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { Check, ChevronRight } from "./icons.ts";
import { SelectionHighlight } from "./SelectionHighlight.tsx";

import { scaled, useApp, viewportWidth } from "../lib/store.ts";

export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  hintIcon?: ReactNode;
  icon?: ReactNode;
  selected?: boolean;
  danger?: boolean;
  disabled?: boolean;
  keepOpen?: boolean;
  section?: string;
  action?: { label: string; icon: ReactNode; pressed?: boolean; onSelect: () => void };
  children?: MenuItem[];
  onSelect?: () => void;
}

interface Props {
  trigger?: (props: {
    open: boolean;
    toggle: () => void;
    id: string;
  }) => ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  header?: string;
  controls?: ReactNode;
  footer?: ReactNode;
  clearOf?: string;
  span?: string;
  width?: number;
  gutter?: number;
  searchable?: boolean;
  searchPlaceholder?: string;
  className?: string;
  emptyMessage?: string;
  anchor?: HTMLElement;
  inline?: boolean;
  triggerId?: string;
  onClose?: () => void;
}

export function Menu({
  trigger,
  items,
  align = "start",
  header,
  controls,
  footer,
  clearOf,
  span,
  width = 232,
  gutter = 0,
  searchable = false,
  searchPlaceholder = "Search models",
  className = "",
  emptyMessage,
  anchor,
  inline = false,
  triggerId,
  onClose,
}: Props) {
  const t = useI18n();
  const reducedMotion = useReducedMotion();
  const uiScale = useApp((state) => state.uiScale);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(Boolean(anchor));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const id = triggerId ?? generatedId;
  const visibleItems: (MenuItem & { depth: number })[] = [];
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const contains = (item: MenuItem, words: string[]): boolean => {
    if (!words.length) return true;
    const text = `${item.label} ${item.id} ${item.hint ?? ""}`.toLowerCase();
    return words.every(word => text.includes(word));
  };
  const matches = (item: MenuItem, words: string[]): boolean =>
    contains(item, words) || Boolean(item.children?.some(child => matches(child, words)));
  const collect = (entries: MenuItem[], depth: number, words: string[]) => {
    for (const item of entries) {
      if (!matches(item, words)) continue;
      visibleItems.push({ ...item, depth });
      if (item.children && (words.length || !collapsed.has(item.id))) {
        collect(item.children, depth + 1, contains(item, words) ? [] : words);
      }
    }
  };
  collect(items, 0, terms);
  const selectedItems = visibleItems.filter(item => item.selected);
  const soleSelection = selectedItems.length === 1 ? selectedItems[0]!.id : undefined;
  const toggleGroup = (itemId: string, collapse = !collapsed.has(itemId)) => setCollapsed(previous => {
    const next = new Set(previous);
    if (collapse) next.add(itemId); else next.delete(itemId);
    return next;
  });

  useLayoutEffect(() => {
    const element = menu.current;
    if (!open || !element) return;
    element.showPopover();
    const position = () => {
      if (anchor && !anchor.isConnected) { setOpen(false); return; }
      const spanned = span ? wrap.current?.closest(span)?.getBoundingClientRect() : undefined;
      const bounds = spanned ?? (anchor ?? (inline ? wrap.current?.firstElementChild : wrap.current))?.getBoundingClientRect();
      if (!bounds) return;
      const scale = uiScale / 100;
      const clearance = clearOf ? wrap.current?.closest(clearOf)?.getBoundingClientRect() : undefined;
      const anchorLeft = (clearance?.left ?? bounds.left) / scale;
      const menuWidth = Math.min(spanned ? spanned.width / scale : inline ? Math.max(width, bounds.width / scale) : width, viewportWidth() - 24 - 2 * gutter);
      const preferred = align === "end" ? bounds.right / scale - menuWidth : anchorLeft;
      element.style.width = `${scaled(menuWidth)}px`;
      element.style.maxHeight = "";
      element.style.minHeight = "";
      const height = element.offsetHeight / scale;
      const top = clearance?.top ?? bounds.top;
      const above = Math.max(0, top / scale - 18);
      const below = Math.max(0, (innerHeight - bounds.bottom) / scale - 18);
      const upwards = height > below && above > below;
      const available = upwards ? above : below;
      element.dataset.side = upwards ? "top" : "bottom";
      element.style.maxHeight = `${scaled(available)}px`;
      if (parseFloat(getComputedStyle(element).minHeight) > scaled(available)) element.style.minHeight = `${scaled(available)}px`;
      element.style.left = `${scaled(Math.max(12 + gutter, Math.min(preferred, viewportWidth() - menuWidth - 12 - gutter)))}px`;
      element.style.top = `${scaled(upwards ? top / scale - Math.min(height, available) - 6 : bounds.bottom / scale + 6)}px`;
    };
    position();
    if (searchable) {
      element.querySelector<HTMLInputElement>(".menu-search")?.focus({ preventScroll: true });
    } else {
      const selected = menu.current?.querySelector<HTMLButtonElement>(
        '[role="menuitem"][data-selected="true"]:not(:disabled)',
      );
      (
        selected ??
        menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      )?.focus({ preventScroll: true });
    }
    const resize = new ResizeObserver(position);
    resize.observe(element);
    const source = anchor ?? wrap.current;
    if (source) resize.observe(source);
    const removed = anchor ? new MutationObserver(() => {
      if (!anchor.isConnected) setOpen(false);
    }) : undefined;
    removed?.observe(document.body, { childList: true, subtree: true });
    const scroll = (event: Event) => {
      if (!element.contains(event.target as Node)) position();
    };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", scroll, true);
    return () => {
      resize.disconnect();
      removed?.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open, width, gutter, align, searchable, uiScale, anchor, clearOf, span, inline]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node) && !anchor?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        (anchor ?? document.getElementById(id))?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, id, anchor]);

  useLayoutEffect(() => {
    if (open && document.activeElement === document.body)
      menu.current?.querySelector<HTMLElement>(".menu-search, .menu-item")?.focus({ preventScroll: true });
  }, [open, items]);

  return (
    <div
      className="menu-wrap"
      style={anchor || inline ? { display: "contents" } : undefined}
      ref={wrap}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      {trigger?.({ open, toggle: () => { if (!open) setQuery(""); setOpen((value) => !value); }, id })}
      <AnimatePresence onExitComplete={onClose}>
        {open && (
          <motion.div
            ref={menu}
            className={`menu ${className}`}
            popover="manual"
            data-align={align}
            style={{ width: scaled(width) }}
            role="menu"
            tabIndex={-1}
            aria-labelledby={anchor ? undefined : id}
            aria-label={anchor ? header : undefined}
            initial={{ opacity: 0, scale: reducedMotion ? 1 : 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: reducedMotion ? 1 : 0.985, pointerEvents: "none" }}
            transition={{ duration: reducedMotion ? 0 : 0.16, ease: [0.16, 1, 0.3, 1] }}
            onKeyDown={(event) => {
              if (event.target instanceof HTMLSelectElement) return;
              const option = (event.target as HTMLElement).closest(".menu-option");
              const groupId = option?.getAttribute("data-group");
              if (groupId && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
                event.preventDefault();
                toggleGroup(groupId, event.key === "ArrowLeft");
                return;
              }
              if (option && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
                const target = option.querySelector<HTMLButtonElement>(event.key === "ArrowRight" ? ".menu-item-action" : ".menu-item");
                if (target) { event.preventDefault(); target.focus(); }
                return;
              }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
                return;
              if (
                event.target instanceof HTMLInputElement &&
                ["Home", "End"].includes(event.key)
              )
                return;
              const buttons = Array.from(
                menu.current?.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitem"]:not(:disabled)',
                ) ?? [],
              );
              if (!buttons.length) return;
              event.preventDefault();
              const current = buttons.indexOf(
                (option?.querySelector(".menu-item") ?? document.activeElement) as HTMLButtonElement,
              );
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : event.key === "ArrowDown"
                      ? (current + 1) % buttons.length
                      : current <= 0
                        ? buttons.length - 1
                        : current - 1;
              buttons[next]?.focus();
            }}
          >
            {header && <div className="menu-header eyebrow">{header}</div>}
            {controls}
            {searchable && (
              <input
                className="menu-search"
                aria-label={t(searchPlaceholder)}
                placeholder={t(searchPlaceholder)}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            )}
            {(items.length > 0 || !controls) && <div className="menu-list scroll sliding-selection" data-large={visibleItems.length > 40} data-sliding={soleSelection ? true : undefined}>
              {soleSelection && <SelectionHighlight value={soleSelection} selector=".menu-option[data-selected]" />}
              {visibleItems.map((item, index) => (
                  <Fragment key={item.id}>
                    {item.section &&
                      item.section !== visibleItems[index - 1]?.section && (
                        <div className="menu-section">{item.section}</div>
                      )}
                    <div className="menu-option" data-selected={item.selected || undefined} data-group={item.children ? item.id : undefined}>
                      <button
                        type="button"
                        disabled={item.disabled}
                        role="menuitem"
                        tabIndex={-1}
                        className="menu-item"
                        data-selected={item.selected || undefined}
                        data-danger={item.danger || undefined}
                        data-depth={item.depth || undefined}
                        style={item.depth ? { paddingInlineStart: `calc(10px + ${item.depth} * var(--menu-nesting-indent, 18px))` } : undefined}
                        aria-expanded={item.children ? Boolean(terms.length) || !collapsed.has(item.id) : undefined}
                        title={item.hint}
                        onClick={() => {
                          if (item.children) { toggleGroup(item.id); return; }
                          if (!item.keepOpen) {
                            setOpen(false);
                            (anchor ?? document.getElementById(id))?.focus({ preventScroll: true });
                          }
                          item.onSelect?.();
                        }}
                      >
                        {item.icon && (
                          <span className="menu-icon">{item.icon}</span>
                        )}
                        <span className="menu-copy">
                          <span className="menu-label truncate">
                            {item.label}
                          </span>
                          {item.hint && (
                            <span className="menu-hint">
                              {item.hintIcon}
                              <span className="truncate">{item.hint}</span>
                            </span>
                          )}
                        </span>
                        {item.selected && (
                          <Check size={13} className="menu-check" />
                        )}
                        {item.children && <ChevronRight size={13} className="menu-group-chevron" data-expanded={Boolean(terms.length) || !collapsed.has(item.id)} />}
                      </button>
                      {item.action && <button
                        type="button"
                        className="menu-item-action"
                        aria-label={item.action.label}
                        title={item.action.label}
                        aria-pressed={item.action.pressed}
                        onClick={item.action.onSelect}
                      >{item.action.icon}</button>}
                    </div>
                  </Fragment>
                ))}
              {!visibleItems.length && (
                <div className="menu-empty">
                  {terms.length ? t("No matches") : emptyMessage ?? t("No options available")}
                </div>
              )}
            </div>}
            {footer}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
