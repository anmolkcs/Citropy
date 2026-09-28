# Citropy design

## Composition

Calm and sparse. Everything shares one left edge, and nothing is there for decoration.

- Every element on a page starts at the same left edge.
- Page headers are the title and its actions. No description line, no icon.
- Section lists (settings, usage, source control, GitHub) keep one icon per item, since long lists are scanned by shape.
- Simple settings are open rows, not boxes. A bold sentence-case heading starts a section, and `--line` rules separate one setting row from the next. Complex blocks, like a provider with its accounts and actions, keep a `--panel` box.
- Menus, popovers, inputs and buttons keep their fills. Rules are for page structure. The one framed box is a result card in the conversation, like the changed-files summary: a `--line-strong` outline on `--canvas`, no fill.
- Empty states are one useful sentence, plus an action when there is one. No icon, no slogan.
- Labels like "Experimental" are plain `--text-3` text, not pills.
- The selected state is a fill change, `--accent-soft` or `--raised-2`. Never a ring.
- Focus rings stay for keyboard users only (`:focus-visible`), using `--field-focus-color`.
- Section pages sit on a solid `--canvas`. The background decoration shows in the conversation view.

## Surfaces

Dark theme, from deepest to highest:

| Token | Value | Use |
| --- | --- | --- |
| `--canvas-deep` | `#1a1918` | wells, tracks, segmented control backgrounds |
| `--canvas` | `#1f1e1d` | app background |
| `--panel`, `--overlay` | `#262624` | panels, menus |
| `--raised` | `#2e2d2b` | inputs, hover |
| `--raised-2` | `#383734` | selected segment, pressed |

The neutral theme is warm grey in both schemes. Light theme mirrors these in `web/src/styles/tokens.css`.

## Type

Geist Variable by Vercel is the UI font, and Droid Sans Mono is the code font. Every font size is a token. Use `--text-2xs` (11px) for badges and tiny labels, `--text-xs` to `--text-body` (12 to 15px) for UI, `--text-lg` (17px) for section headings, `--text-title` (20px) for page titles and `--text-display` (28px) for large numbers. Labels are 500 weight, and secondary detail uses `--text-3` rather than a smaller size.

## Line counts

Added and removed lines always use `LineCounts` (`web/src/components/LineCounts.tsx`): green `+N` and red `-N` with a 4px gap, both always shown.

## Density

Every pixel value scales with the UI size setting (`--ui-scale`). The default is 90% with a mouse, for a denser layout like Claude's, and 100% on touch screens so tap targets stay large. `DEFAULT_UI_SCALE` in `web/src/lib/app-state.ts` holds it.

## Spacing

Padding, margin and gap use the `--space-*` scale: 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48 and 64px. Raw pixel values are only for 1px nudges and negative offsets that align an edge.

## Color

One accent per theme. Other hues only carry meaning: `--ok`, `--warn` and `--bad` for status, provider series in charts, GitHub states, and file-type icons. Decorative icons use `--text-3`.

## Navigation

On desktop the sidebar holds everything, with navigation in its footer. The side strip is an opt-in layout in Appearance settings, and phones always use it as the bottom tab bar.

## Controls

- Group related settings behind one trigger. The model picker holds effort, context and speed as tabs instead of separate buttons.
- Panels size to their content. Side buttons that switch them stay in place, so the window can change height without anything you click moving.
- Prefer native elements with custom styling, like `<input type="range">` for the effort slider and a checkbox with `role="switch"` for toggles.
- Rounded corners use the `--r-*` scale. Pills (`--r-full`) are for sliders, toggles and small markers like the icon stack and the thought dots.

## Motion

Anything that directly answers a click changes instantly: selection highlights, page and section titles, navigation. Motion is only for things that appear or move into place, like menus, popovers, drawers and the composer. No bounce.

Short and eased with `--ease-out`, at `--dur-instant`, `--dur-fast` or `--dur-base`. Side panels use `--ease-drawer`. Lists that appear together stagger by 40 to 70ms. Things that move across the screen, like the composer on first send, keep their position continuous instead of jumping. Respect reduced motion by keeping fades and dropping movement.

## Never

- Emoji or icon glyphs as decoration.
- Borders framing boxes, except conversation result cards.
- Controls that move when their value changes.
