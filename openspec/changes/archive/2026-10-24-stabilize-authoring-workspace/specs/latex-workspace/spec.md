# Spec Delta

## ADDED Requirements

### Requirement: Stable source line geometry
The editor SHALL show one line number per logical source line, aligned with that line's first visual row within 1.5 CSS pixels after layout settles. Wrapping, resizing, scrolling, font loading, font-size changes and concurrent edits SHALL preserve this alignment. Gutter text SHALL NOT enter source selections or copied source text.

#### Scenario: Wrapped long document
- **WHEN** a member scrolls and edits a 6200-line document containing long wrapped lines, blank lines, Unicode and equations
- **THEN** visible line numbers identify the correct logical lines, stay aligned within the tolerance and the editor does not leave blank visible source regions after layout settles

#### Scenario: Resize and font change
- **WHEN** the member changes the font between 11, 14, 18 and 24 px, resizes the panes and switches themes
- **THEN** gutter and source metrics remain aligned and the caret remains visible without scrolling the whole application

#### Scenario: Peer inserts lines above the viewport
- **WHEN** a co-author inserts or deletes lines above the local member's viewport while the local member has a selection
- **THEN** visible numbering follows the merged source, selection remains visible and typing continues in the intended file

#### Scenario: Windows line endings and source copy
- **WHEN** a member opens LF or CRLF source, selects across wrapped lines and copies it
- **THEN** the copied source contains no gutter numbers and the local line/column indicator refers to logical source lines

### Requirement: Revision-safe preview replacement
The preview SHALL use PDF bytes and source mappings from the same successful local build. Superseded loads, render completions and errors SHALL NOT replace the current preview or its status. A missing mapping SHALL disable source/PDF jumps until the matching mapping is available. A failed build SHALL keep the last good PDF and its mapping together.

#### Scenario: Mapping still loading
- **WHEN** a new PDF is displayed while its source mapping is still loading
- **THEN** navigation does not use the preceding PDF's mapping and becomes available only with the matching mapping

#### Scenario: Obsolete renderer finishes late
- **WHEN** PDF A starts loading, PDF B supersedes it and A later succeeds or fails
- **THEN** B remains the selected preview and A changes neither its content nor its error state

#### Scenario: Build completes after another edit
- **WHEN** a build captured source revision A and revision B was edited before A finished
- **THEN** the PDF for A is identified as outdated and pending-change information includes B

### Requirement: Responsive long PDF preview
The preview SHALL display the current visible page without waiting for every page of a long PDF to render. Updating the PDF or zoom SHALL preserve the reading location by page and relative position where that page still exists. Superseded and closed previews SHALL release rendering resources. Rendering SHALL NOT take focus from the source editor.

#### Scenario: Long PDF update while writing
- **WHEN** a new 100-page PDF arrives while the member types and reads page 50
- **THEN** page 50 is prioritized, the reading position is retained and typing continues in the editor while other pages become available on demand

#### Scenario: Rapid zoom followed by project close
- **WHEN** a member changes zoom repeatedly and closes the project while pages render
- **THEN** no obsolete page or error appears in the next project and the closed preview's workers and render tasks are released
