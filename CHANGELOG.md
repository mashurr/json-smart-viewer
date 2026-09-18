# Change Log

## [0.1.0]

- Opens files of hundreds of megabytes: the viewer only builds what's on screen, and files over 50 MB are read straight from disk. Available from the editor title and the Explorer.
- Linked to the editor: clicking a value selects it in the file, moving the cursor reveals it in the viewer, and edits show up once you pause typing.
- Search keys and values, with match counts and Enter / Shift+Enter to step through them.
- Copy path, JSON Pointer or value from any row.
- Table view for arrays of objects, maps of objects and mixed arrays, with sorting.
- Graph view: one card per object or array, with pan and zoom.
- Opens JSON inside strings, JSONC files, JSON Lines files and selected text (e.g. JSON in a log line).
- Colour swatches, readable dates and timestamps, and links you can Ctrl/Cmd+click.
- Expand all and collapse all.
- Follows your VS Code theme and works offline; nothing is loaded from the internet.
- Big numbers are shown and copied exactly as written.
- Rewritten in TypeScript.

## [0.0.1]

- Initial release.
