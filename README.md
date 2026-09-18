# JSON Smart Viewer

Explore big or messy JSON as a tree, table or graph, side by side with your editor. Files of hundreds of megabytes open in a second or two.

![JSON Smart Viewer: tree, search, table and graph beside the editor](images/demo.gif)

## Features

- **Open** a JSON file and click **JSON Smart View** in the editor title, or right-click a file in the Explorer. For JSON inside another file, such as a log line, select it and choose **Open Selection in JSON Smart View**.
- **Large files**: only what's on screen is built, so 200 MB files and million-item arrays stay fast. Big arrays and objects open in groups of 100.
- **Linked to the editor**: click a value to select it in the file; move the cursor in the file to reveal it in the viewer. Edits show up once you pause typing.
- **Search** keys and values, including escaped text. **Enter** and **Shift+Enter** step through matches.
- **Copy** a path (`orders[12].total`), JSON Pointer (`/orders/12/total`) or value from the right-click menu, or copy the selected value with **Ctrl+C** / **Cmd+C**.
- **Table** view for arrays of objects, maps of objects and mixed arrays. Click a column to sort.
- **Graph** view with a card per object or array. Drag to pan, scroll to zoom.
- **JSON inside strings** opens like any object. **JSONC** comments and **JSON Lines** files work too; bad lines are shown with their line number.
- **Previews**: colour swatches, readable dates and timestamps, and links that open with **Ctrl+click** / **Cmd+click**.
- Follows your theme, works offline, and shows big numbers exactly as written.

## Requirements

- VS Code 1.90 or later.

## Known Issues

- VS Code doesn't share files over 50 MB with extensions. For those, clicking in the viewer still jumps to the value in the editor, but the viewer can't follow the cursor or your unsaved edits. It refreshes when the file is saved.
- Inserting an item into an array shifts the indexes after it, so an open `orders[5]` then shows whatever is now at position 5.
- Paths nested more than 1,000 levels deep are revealed down to level 1,000.
- JSON inside strings opens in the tree; the table and graph show those strings as text.

Report issues on [GitHub](https://github.com/mashurr/json-smart-viewer/issues).

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).
