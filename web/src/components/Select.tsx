import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Menu } from "./Menu.tsx";

interface SelectOption {
  value: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  disabled?: boolean;
}

interface Props {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  name?: string;
  id?: string;
  className?: string;
  title?: string;
  "aria-label"?: string;
  width?: number;
}

export function Select({
  options,
  value,
  defaultValue = "",
  onChange,
  placeholder = "",
  disabled = false,
  name,
  id,
  className = "",
  title,
  "aria-label": ariaLabel,
  width = 180,
}: Props) {
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const current = value ?? uncontrolled;
  const selected = options.find((option) => option.value === current);
  const choose = (next: string) => {
    if (value === undefined) setUncontrolled(next);
    if (next !== current) onChange?.(next);
  };
  return (
    <>
      <Menu
        inline
        triggerId={id}
        width={width}
        items={options.map((option) => ({
          id: `option:${option.value}`,
          label: option.label,
          icon: option.icon,
          hint: option.hint,
          disabled: option.disabled,
          selected: option.value === current,
          onSelect: () => choose(option.value),
        }))}
        trigger={({ id: triggerId, open, toggle }) => (
          <button
            id={triggerId}
            type="button"
            className={`select ${className}`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={ariaLabel}
            title={title}
            disabled={disabled}
            onClick={toggle}
            onKeyDown={(event) => {
              if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                toggle();
              }
            }}
          >
            {selected?.icon && <span className="select-icon">{selected.icon}</span>}
            <span className="select-label truncate" data-placeholder={!selected || undefined}>
              {selected?.label ?? placeholder}
            </span>
            <ChevronDown size={15} className="select-chevron" aria-hidden="true" />
          </button>
        )}
      />
      {name && <input type="hidden" name={name} value={current} />}
    </>
  );
}
