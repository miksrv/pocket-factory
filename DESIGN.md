# Design rules

Short rules for the web UI. Every form and page follows them; a change that breaks one fixes the
page, not the rule. Tokens, components and icons live in `web/src/styles.css`,
`web/src/components/ui.tsx` and `web/src/components/Icon.tsx`.

## Forms

- **A row is always full.** Fields in a row share its whole width: two selects take half each,
  three take a third each. A row never ends in an empty column.
  `.form-grid` and `.trigger-card` are flex rows with `flex-wrap`, every field `flex: 1 1 260px`;
  never lay out a form with `grid` + `auto-fill` (it keeps empty tracks alive).
- **`wide` takes a row alone**: textareas, pickers, checkbox groups, lists of cards.
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
- **A checkbox label is a short phrase** (`drafts`, `new items only`), not a sentence.
- On a phone or a narrow window (≤ 900px) every field takes the full row.

## Sections

- **A long form is split into sections**, each under a heading: `SectionHead` from `ui.tsx`
  (title, one short line under it, actions such as `＋ File` or the Preview / Edit tabs on the
  right, a rule above). A block that is a list of cards or rows (Pipeline, Schedule, Hosts,
  Toolchain, MCP servers, Tools, a skill's files) and the Markdown body are sections; a
  `Field` with `section` renders one. The first section of a form has no rule.
- Plain fields (selects, inputs, checkboxes) are never sections; they sit in rows between them.
- **"More"** folds what is rarely changed; its summary reads as a section heading and names
  what is inside. A field that only an older file uses (a routine's hosts, a continued session)
  shows only when the file has it.

## Code and files

- **Code is edited in the code editor** (`CodeEditor`, CodeMirror): a script, a config, a data file.
  A textarea is for prose (instructions, descriptions), never for a script.
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
  compose them and never repeat their markup.
- Every destructive action goes through `useConfirm()`, never `window.confirm`.
- Icons only through `components/Icon.tsx`: the same icon for the same concept everywhere; a
  tile never changes size.

## Look

- Light theme by default (paper background, dot grid, mono font, pastel pills, icon tiles) and a
  dark theme on the same tokens. Colours only through the tokens; never a literal `#fff` on an
  ink or red surface.
- One badge per sidebar item: unread (green) > waiting (amber) > running (blue).
- No money anywhere: tokens and window shares only.
- No blinking title. External links in rendered Markdown open in a new tab, links into the
  factory stay.
