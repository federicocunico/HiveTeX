# Importing existing projects

You can bring existing LaTeX sources into HiveTeX when you **create a project** (the *Start from existing sources*
fields) or, if you are an owner or editor, **inside an open project** with **Import…** in the toolbar. Uploading or
dropping files and folders on the file tree goes through the same steps.

Everything happens **on your device**. Archives and files are read in the browser (or desktop app) and reach your
collaborators only through the normal peer-to-peer sync. Nothing is uploaded to the server.

## What you can import

| Source | How |
|---|---|
| Overleaf project | Overleaf → *Menu* → *Download* → *Source* gives a `.zip`; import it as is |
| arXiv paper | arXiv abstract page → *TeX Source*: a `.tar.gz` (sometimes without the extension); import it as is |
| GitHub repository | *Code* → *Download ZIP* (the `repo-main/` folder is stripped automatically) |
| Folder on disk | *Folder…* in the import dialog, or drag the folder onto the file tree |
| Individual files | *Archive or files…*, the ⬆ buttons in the file tree, or drag and drop |

Supported archive formats: `.zip`, `.tar`, `.tar.gz` / `.tgz`. `.rar`, `.7z` and others are refused: extract them first
and import the folder.

## What happens to the files

- **Top-level folder.** If every file in an archive (or an imported folder) is inside one folder, that folder is
  removed so the document sits at the project root. Folders you **drop on the tree** keep their name.
- **Skipped files.** Build output (`.aux`, `.log`, `.out`, `.toc`, `.synctex.gz`, `.fdb_latexmk`, …), system files
  (`__MACOSX/`, `.DS_Store`, `Thumbs.db`) and tool folders (`.git/`, `.svn/`, `node_modules/`, `.vscode/`, …) are not
  imported. The summary lists each skipped file and the reason. `.bbl` files are **kept**, because arXiv sources often
  ship them instead of a `.bib`.
- **Text or binary.** LaTeX and related text files (`.tex`, `.bib`, `.sty`, `.cls`, `.bst`, `.bbl`, `.cfg`, `.txt`,
  `.md`, `.csv`, `latexmkrc`, …) become editable documents. Images, PDFs, fonts and other files are stored byte for byte
  and can be downloaded unchanged.
- **Encoding.** Text is read as UTF-8. Files that are not valid UTF-8 (typically old Latin-1 / Windows sources) are
  read as Windows-1252 and stored as UTF-8. The summary lists these files so you can check accented characters. If
  the document says `\usepackage[latin1]{inputenc}`, change it to `utf8` or remove it.
- **Main file.** The main file is chosen in this order:
  1. the target of a `% !TEX root = …` comment,
  2. `main.tex`,
  3. a top-level `.tex` file with `\documentclass` and `\begin{document}`,
  4. any such file.

  When several documents qualify, the dialog asks you to choose. When you import into a project that already has a
  main file, it stays unless you change it in the preview.
- **Compiler.** If the project has no compiler set yet, a `% !TEX program = xelatex|lualatex|pdflatex` comment in the
  main file selects it. Otherwise loading `fontspec`, `unicode-math` or `polyglossia` selects XeLaTeX. Overleaf zips do
  not include Overleaf's compiler setting, so check *Project settings* if your project needs a specific one.

## Importing into a project that already has files

Before anything is written, a preview shows how many files are **new**, **changed**, **identical** and **skipped**.
You can:

- **Add and update files** (default): new files are added. For each file that exists with different content, choose
  *Keep existing* or *Overwrite*, or use *Keep all* / *Overwrite all*. Files that are not in the import are left alone.
- **Replace project contents**: the project ends up exactly like the import, and files not in it are deleted. This
  asks for a second confirmation. You can undo it from *History*.

Overwriting a text file applies the difference as a normal edit. Collaborators who have that file open see the new text
without the file closing.

*Cancel* (or <kbd>Esc</kbd>) leaves the project untouched. If the archive is damaged or unsafe, nothing is imported.

Uploading files or folders to the tree adds them straight away when nothing conflicts. If a name is already taken, or
something was skipped, the same preview opens. If you upload or drop a single archive, you can choose to **Extract** it
or **Add as file**.

## Limits and safety

| Limit | Value | When exceeded |
|---|---|---|
| Size of one file | 50 MB | the file is skipped and listed in the summary; the rest is imported |
| Total extracted size | 500 MB | the import is refused |
| Number of entries | 5000 | the import is refused |

The whole import is refused if any entry has an absolute path, a drive letter or a `..` segment, or is a symbolic or
hard link. These are typical of malicious archives. Zip and gzip bombs are stopped before they are fully
decompressed.

Large imports show a progress bar. All new files reach your collaborators as **one** change, so they never see a
half-imported tree.
