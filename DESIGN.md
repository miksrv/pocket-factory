# Design rules

Short rules for the web UI. Every form and page follows them; a change that breaks one fixes the
page, not the rule. Tokens, components and icons live in `web/src/styles.css`,
`web/src/components/ui.tsx` and `web/src/components/Icon.tsx`.

## Forms

- **A row is always full.** Fields in a row share its whole width: two selects take half each,
  three take a third each. A row never ends in an empty column.
  `.form-grid`, `.trigger-card` and `.host-card` are flex rows with `flex-wrap`, every field
  `flex: 1 1 260px`; never lay out a form with `grid` + `auto-fill` (it keeps empty tracks alive).
  A grid of cards (agents, presets) may use `auto-fill`: its cards are not fields.
- **`wide` takes a row alone**: textareas, pickers, checkbox groups, lists of cards; never a
  single input or select to make room for its hint (shorten the hint instead).
- **Order fields so rows fill well**: fields that belong together (Agent + Skill, First run + Max
  items) sit next to each other; a lone short field after a wide one stretches across the row,
  which is fine.
- **A hint is one short line on a desktop.** At most ~40 characters for a field that shares its
  row, ~100 for a `wide` one. It says what the owner must know to fill the field, not how the
  feature works.
- **The explanation goes elsewhere**: the section's intro line above the fields, a `title`
  tooltip on the control, or the docs. Never a paragraph under a field.
- **The label is a few words**, one line; units and formats go into the label
  (`Timeout (seconds)`) or the placeholder, not the hint.
- **A button beside a field is the field's height** (Create, Add, Set next to an input or a
  select): it stretches to the field, never sits as a small button in the middle of the row.
  `.row:has(> input, > select) > .btn` does it in `styles.css`; such a button is the default
  size, not `sm`.
- **A checkbox or radio label is a short phrase starting with a capital** (`Drafts`, `New items only`,
  `Every routine and chat`), not a sentence. A name picked from a list (a routine, a tool) stays as written.
- **A choice that cannot be made is visibly off**: a disabled checkbox or radio is dimmed with its
  caption and shows `not-allowed`; its `title` says why.
- On a phone or a narrow window (≤ 900px) every field takes the full row.

## Sections

- **A long form is split into sections**, each under a heading: `SectionHead` from `ui.tsx`
  (title, one short line under it, actions such as `＋ File` or the Preview / Edit tabs on the
  right, a rule above). A block that is a list of cards or rows (Pipeline, Schedule, Hosts,
  Network, MCP servers, Tools, a skill's files) and the Markdown body are sections; a
  `Field` with `section` renders one. The first section of a form has no rule.
- Plain fields (selects, inputs, checkboxes) are never sections; they sit in rows between them.
- **"More"** folds what is rarely changed; its summary reads as a section heading and names
  what is inside. A part of a form that is not folded but set apart by a rule is a section too:
  it has a `SectionHead`, never a bare line. A field that only an older file uses (a routine's hosts, a continued session)
  shows only when the file has it.

## Code and files

- **Code is edited in the code editor** (`CodeEditor`, CodeMirror): a script, a step's command, a
  config (JSON), a certificate, a data file. A textarea is for prose (instructions, descriptions),
  never for a script.
- **A folder's files** (a skill's, a routine's) are one `FolderFiles` section: a list, one row per
  file under its directory; a click opens the file in a large window (the editor across it, a CSV
  as a table first). A step's window shows its own script in place (`FileEditor compact`).
- **A pipeline is a graph**: steps are cards top to bottom with arrows, each
  with its last result, what it is for and what it misses; a step is edited in a window, never
  inline in the page. The page stays a summary.
- **A script says what it is**: the card shows the comment under the shebang as the step's
  description; a new script starts with a header to fill.
- **A secret is never shown**: its field is write-only (Update replaces it); a variable shows its
  value. What a step reads is a line of chips, each set / not set, with Set beside a missing one.

## Windows

- **A window has a header**: the tile on the left, the title and one line under it (cut with an
  ellipsis, whole in its tooltip), the close button on the right, a rule below. What does not fit
  in one line goes into the body.
- **The body runs the whole width** of the window under the header, never indented under the tile.
  A confirmation's message is the body.

## Components

- Buttons, tabs, stats, empty states, errors and page heads come from `components/ui.tsx`; pages
  compose them and never repeat their markup. A list's load error is an `ErrorBox`; an error under
  one control is `<ErrorBox inline>`; "nothing here yet" inside a section is `<Empty inline>`.
- Every destructive action goes through `useConfirm()`, never `window.confirm`.
- Icons only through `components/Icon.tsx` (never `lucide-react` directly): the same icon for the
  same concept everywhere; a tile never changes size. A state mark (done, failed, needs a look), a
  disclosure arrow, an "open elsewhere" arrow, the menu and the add sign are icons too, never
  glyphs like `✓ ✗ ⚠ ▸ ↗ ☰ ＋`; arrows inside prose (`Settings → Hosts`) are words and stay.
- Layout lives in classes: an inline `style` is for a one-off value, never a pattern repeated on
  the page.

## Look

- Light theme by default (paper background, dot grid, mono font, pastel pills, icon tiles) and a
  dark theme on the same tokens. Colours and shadows only through the tokens (`--shadow-sm`,
  `--shadow`, `--shadow-lg`, `--shadow-drawer`, `--red-hover`…); never a literal colour, `#fff` on
  an ink or red surface least of all. A new token is defined in both themes.
- One badge per sidebar item: unread (green) > waiting (amber) > running (blue).
- No money anywhere: tokens and window shares only.
- No blinking title. External links in rendered Markdown open in a new tab, links into the
  factory stay.

## Accessibility

WCAG 2.2 AA, checked in both themes (a token change is measured against every surface it sits on).

- **Contrast**: text and placeholders at least 4.5:1 against `--bg`, `--surface` and `--surface-2`
  (`--text-dim` is the floor, not a lighter shade below it); a pill's text 4.5:1 on its own `-bg`.
  A field's edge (`--field-border`) and any icon that carries meaning alone 3:1.
- **Focus is always visible**: buttons and links get the blue `:focus-visible` outline, fields a
  2px blue ring (border + outline, so it survives forced colours). Never `outline: none` without a
  replacement of at least that strength.
- **Motion**: under `prefers-reduced-motion` nothing pulses, blinks, glows or slides (one rule at
  the end of `styles.css`); state is never shown by motion alone.
- **Targets** at least 24×24px (`.btn.sm`, chips, tabs); a lone icon button 28px.
- **Text** at least 11px, labels and badges included.
- An icon-only control has an `aria-label`; an icon next to a word is `aria-hidden` (`Icon` does
  it).
- Nothing appears only on hover: a phone has no hover.
