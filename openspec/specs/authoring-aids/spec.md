# authoring-aids Specification

## Purpose
Helps people who do not know LaTeX by heart write a paper: insert common structures without memorizing commands,
navigate the document by its outline, and understand compile errors in plain language.

## Requirements

### Requirement: Formatting toolbar
For editors, the workspace SHALL show a formatting toolbar above the source editor that inserts:
- sectioning (part to subparagraph);
- bold and italic;
- bulleted and numbered lists;
- inline and display math;
- a symbol;
- a figure;
- a table;
- a citation;
- a cross-reference.

When text is selected, an action SHALL wrap the selection. Each button's tooltip SHALL show the LaTeX it inserts.
Viewers SHALL NOT see the toolbar.

#### Scenario: Bold a selection
- **WHEN** an editor selects "graph" and activates Bold
- **THEN** the text becomes `\textbf{graph}` and the change syncs to co-authors like any other edit

#### Scenario: Insert a section
- **WHEN** an editor chooses "Subsection" from the section menu with no selection
- **THEN** `\subsection{}` is inserted with the cursor between the braces

#### Scenario: Viewer
- **WHEN** a viewer opens a `.tex` file
- **THEN** no formatting toolbar is shown

### Requirement: Bold and italic shortcuts
In `.tex` files the editor SHALL apply bold with Ctrl/Cmd+B and italic with Ctrl/Cmd+I, the same as the toolbar
buttons.

#### Scenario: Italic shortcut
- **WHEN** an editor selects a word and presses Ctrl+I
- **THEN** the word is wrapped in `\textit{}`

### Requirement: Figure and table helpers
Inserting a figure SHALL let the user pick an image from the project and SHALL insert a `figure` environment with
`\includegraphics`, a caption and a label placeholder. Inserting a table SHALL let the user pick rows and columns and
SHALL insert a `table` environment with a `tabular` of that size, a caption and a label placeholder.

#### Scenario: Insert a figure
- **WHEN** an editor inserts a figure and picks `figures/pipeline.pdf`
- **THEN** a `figure` environment referencing `figures/pipeline` with `\caption{}` and `\label{fig:pipeline}` is
  inserted at the cursor

#### Scenario: Insert a 3 by 4 table
- **WHEN** an editor inserts a table with 3 rows and 4 columns
- **THEN** a `tabular` with 4 column specifiers and 3 rows of `&`-separated cells is inserted

### Requirement: Citation and reference pickers
Inserting a citation SHALL open a searchable list of the project's bibliography entries, showing key, authors, title
and year. Inserting a cross-reference SHALL open a searchable list of the project's labels. These SHALL use the same
data as the editor's existing completion.

#### Scenario: Pick a citation
- **WHEN** an editor opens the citation picker, types "anfinsen" and selects `anfinsen73`
- **THEN** `\cite{anfinsen73}` is inserted

### Requirement: Symbol palette
The workspace SHALL offer a searchable symbol palette of at least Greek letters, relations, operators, arrows and
common math symbols. It SHALL be searchable by name and by command. Inserting a symbol outside math mode SHALL wrap it
in `$…$`.

#### Scenario: Insert by name
- **WHEN** an editor searches the symbol palette for "less or equal" and picks it
- **THEN** `\leq` is inserted, wrapped in `$…$` if the cursor is not in math mode

### Requirement: Document outline
The Outline panel SHALL list the sectioning commands of the document, following `\input` and `\include`, in
document order and indented by level. It SHALL mark the section that holds the cursor. Selecting an entry SHALL open
its file at that line. The outline SHALL update as co-authors edit.

#### Scenario: Jump to a section
- **WHEN** a user selects "2.1 Residue graphs" in the outline
- **THEN** the editor opens the file containing it with the cursor on that heading

#### Scenario: Co-author adds a section
- **WHEN** a co-author adds `\section{Discussion}`
- **THEN** "Discussion" appears in the outline without reloading

### Requirement: Plain-language compile problems
The workspace SHALL list compile errors and warnings in a Problems panel. Each entry SHALL give:
- the file and line;
- the original message;
- for known common errors, a plain-language explanation and the usual fix.

Selecting an entry SHALL move the editor to that line. The raw log SHALL stay one action away.

#### Scenario: Unknown command from a missing package
- **WHEN** a compile fails with "Undefined control sequence" on `\citep` and natbib is not loaded
- **THEN** the Problems panel says `\citep` comes from the `natbib` package, offers to add `\usepackage{natbib}`, and
  "Go to line" moves the cursor to the failing line

#### Scenario: Unknown error
- **WHEN** a compile fails with an error that has no known explanation
- **THEN** the entry shows the original message, file and line, with no invented explanation

### Requirement: One-click fixes are ordinary edits
A fix applied from the Problems panel SHALL be a normal edit by the user who applied it. It SHALL appear in Changes
and be undoable like any other edit, and SHALL only be offered to editors.

#### Scenario: Undo a fix
- **WHEN** an editor applies "Add natbib" and then presses Undo
- **THEN** the inserted `\usepackage{natbib}` line is removed
