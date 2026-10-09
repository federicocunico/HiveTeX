# Spec Delta

## Purpose

Lets users bring existing LaTeX work — Overleaf downloads, arXiv source tarballs, GitHub zips, folders and loose files — into a new or existing project safely and predictably, entirely on their own device.

## ADDED Requirements

### Requirement: Supported import sources
Editors SHALL be able to import from a `.zip` archive, a `.tar`, `.tar.gz` or `.tgz` archive, a local folder (picker or drag-and-drop), or one or more loose files, in both the web and desktop apps.

#### Scenario: Overleaf zip
- **WHEN** an editor imports a zip downloaded from Overleaf's "Download → Source"
- **THEN** every source file and image in it appears in the project tree at the same relative path

#### Scenario: arXiv tarball
- **WHEN** an editor imports an arXiv source `.tar.gz` containing `ms.tex`, `refs.bib` and `figs/plot.pdf`
- **THEN** those three files appear in the project with the same relative paths

#### Scenario: Folder drop
- **WHEN** an editor drags a folder `paper/` containing `main.tex` and `img/a.png` onto the file tree
- **THEN** `paper/main.tex` and `paper/img/a.png` are added under the drop target

#### Scenario: Unsupported archive
- **WHEN** an editor imports a `.rar` or `.7z` file
- **THEN** the import is refused with a message listing the supported formats and nothing is changed

### Requirement: Import entry points
Import SHALL be available when creating a project and, for editors, from within an existing project. Viewers SHALL NOT be offered import.

#### Scenario: Create from archive
- **WHEN** a user creates a project and selects an archive or folder on the creation form
- **THEN** the new project opens already containing the imported files

#### Scenario: Import into existing project
- **WHEN** an editor chooses "Import…" in an open project and selects an archive
- **THEN** the import preview opens for that project

#### Scenario: Viewer
- **WHEN** a viewer opens a project
- **THEN** no import or upload action is shown and dropping files on the tree has no effect

### Requirement: Client-side only
Imported content SHALL be read and processed on the user's device and SHALL reach other devices only through the normal peer-to-peer sync; it SHALL NOT be sent to the control plane.

#### Scenario: Network during import
- **WHEN** an editor imports a 20 MB archive
- **THEN** no request carrying archive or file content is made to the control plane

### Requirement: Path safety
Import SHALL reject the whole input if any entry has an absolute path, a drive letter, a `..` segment, or is a symbolic or hard link, and SHALL normalize backslashes to `/`.

#### Scenario: Traversal entry
- **WHEN** an archive contains `../../etc/passwd`
- **THEN** the import fails with an "unsafe path" error naming the entry and nothing is added

#### Scenario: Symlink in tarball
- **WHEN** a tarball contains a symbolic link entry
- **THEN** the import fails with an "unsafe entry" error and nothing is added

### Requirement: Size limits
Import SHALL enforce a maximum of 50 MB per extracted file, 500 MB total extracted size and 5 000 entries, checked before extraction completes, and SHALL report which limit was exceeded.

#### Scenario: Zip bomb
- **WHEN** an archive declares a total extracted size above 500 MB
- **THEN** the import stops with "archive too large" and nothing is added

#### Scenario: Oversized loose file
- **WHEN** an editor uploads a single 80 MB video file
- **THEN** that file is rejected with a size message and other files in the same upload are still offered for import

### Requirement: Junk and build-artifact filtering
Import SHALL skip OS metadata (`__MACOSX/`, `.DS_Store`, `Thumbs.db`), VCS/tool folders (`.git/`, `.svn/`, `.claude/`, `.cursor/`, `node_modules/`) and LaTeX build artifacts covered by the folder-mirror ignore list, and SHALL list skipped entries in the summary.

#### Scenario: Archive with build output
- **WHEN** an archive contains `main.tex`, `main.aux`, `main.log` and `main.synctex.gz`
- **THEN** only `main.tex` is imported and the summary reports three skipped build artifacts

### Requirement: Common top-level folder
When every entry of an archive or folder shares one top-level directory, import SHALL strip it so the project root matches the document root.

#### Scenario: GitHub zip
- **WHEN** an archive's entries are all under `paper-main/`
- **THEN** `paper-main/main.tex` is imported as `main.tex`

### Requirement: Text and binary classification
Import SHALL store known LaTeX/text extensions and extension-less files without NUL bytes as editable text, and everything else (images, PDFs, fonts, unknown binaries) as binary assets downloadable byte-for-byte.

#### Scenario: Mixed content
- **WHEN** an archive contains `main.tex`, `refs.bib`, `custom.sty`, `logo.png` and `font.otf`
- **THEN** the first three open in the editor and the last two are binary assets identical to the originals

### Requirement: Text encoding
Text files SHALL be decoded as UTF-8 (BOM stripped). A file that is not valid UTF-8 SHALL be decoded as Windows-1252, stored as UTF-8, and listed in the summary as converted.

#### Scenario: Latin-1 source
- **WHEN** an archive contains a `.tex` file encoded in ISO-8859-1 with the word "perché"
- **THEN** the editor shows "perché" correctly and the summary notes the file was converted from a legacy encoding

### Requirement: Main file detection
After import into a project without a main file, or on create, the main file SHALL be set to the most likely root document, preferring in order: a `% !TEX root` target, `main.tex`, a top-level `.tex` with `\documentclass` and `\begin{document}`, then any such `.tex`. The user SHALL be able to override it in the preview.

#### Scenario: Non-standard main name
- **WHEN** an archive contains `paper.tex` (with `\documentclass` and `\begin{document}`) and `sections/intro.tex` (no `\documentclass`)
- **THEN** `paper.tex` is set as the main file

#### Scenario: User override
- **WHEN** the preview proposes `thesis.tex` and the user selects `frontmatter.tex` instead
- **THEN** `frontmatter.tex` becomes the main file after import

#### Scenario: Existing main kept
- **WHEN** an editor imports files into a project that already has a main file
- **THEN** the main file is unchanged unless the user changes it in the preview

### Requirement: Compiler detection
When the project has no compiler explicitly chosen, import SHALL set it from a `% !TEX program` magic comment in the main file, or to XeLaTeX if the main file loads `fontspec`, `unicode-math` or `polyglossia`; otherwise it SHALL leave the default.

#### Scenario: fontspec document
- **WHEN** a new project is created from an archive whose main file contains `\usepackage{fontspec}`
- **THEN** the project's compiler is XeLaTeX

### Requirement: Import preview and conflict resolution
Importing into a non-empty project SHALL first show a preview of new, changed, identical and skipped files. For changed files the user SHALL choose to overwrite or keep existing (individually or for all), or to replace the whole project. Nothing SHALL change before confirmation.

#### Scenario: Conflict keep existing
- **WHEN** an editor imports an archive containing a different `main.tex` and chooses "keep existing" for it
- **THEN** the project's `main.tex` is unchanged and other new files are added

#### Scenario: Cancel
- **WHEN** an editor cancels the preview
- **THEN** the project is unchanged

#### Scenario: Replace all
- **WHEN** an editor confirms "replace project contents"
- **THEN** files not present in the import are deleted and the project tree equals the imported tree

### Requirement: Overwrite preserves collaboration
Overwriting an existing text file SHALL apply the change as an edit to that file (so concurrent editors and history see a normal edit), not as delete-and-recreate.

#### Scenario: Peer has file open
- **WHEN** an editor overwrites `intro.tex` by import while a co-author has it open
- **THEN** the co-author's editor shows the new content without the file closing or losing its identity

### Requirement: Upload uses the same rules
Uploading or dropping files into the tree SHALL apply the same safety, filtering, classification, encoding and conflict rules; an archive dropped into the tree SHALL be offered for extraction via the preview rather than a blocking browser dialog.

#### Scenario: Upload existing name
- **WHEN** an editor uploads `figure.png` into a folder that already has `figure.png` with different content
- **THEN** the user is asked to overwrite or keep existing before anything changes

#### Scenario: Drop archive into tree
- **WHEN** an editor drops `old-project.zip` into the tree
- **THEN** the user can choose between extracting it (via the preview) or adding the zip as a single binary file

### Requirement: Progress and summary
Imports SHALL show progress for inputs over 50 entries or 5 MB and SHALL end with a summary of imported, overwritten, kept, skipped (with reason) and converted files.

#### Scenario: Summary
- **WHEN** an import finishes
- **THEN** the user sees counts per category and can expand the list of skipped files with reasons

### Requirement: Atomic and coherent application
An import SHALL be applied so that peers observe the imported tree as one consistent change, and a failure while reading the input SHALL leave the project unchanged.

#### Scenario: Corrupt archive
- **WHEN** an archive is truncated and fails to decompress midway
- **THEN** an error is shown and no file from it is added

#### Scenario: Peer view
- **WHEN** an editor imports 200 files while a co-author is connected
- **THEN** the co-author's tree updates to include all 200 files without showing intermediate partial states that persist after the import completes
