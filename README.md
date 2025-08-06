# JSON Smart Viewer

A sleek, high-contrast JSON viewer extension for Visual Studio Code that transforms complex JSON files into an elegant, collapsible tree structure with syntax highlighting.

## Features

JSON Smart Viewer provides an intuitive way to navigate and understand JSON files with these key features:

### 🎯 **Smart Collapsible Tree View**
- Expand/collapse nested objects and arrays with smooth animations
- Clean indentation that shows the hierarchy at a glance
- Item count previews for collapsed sections (e.g., "5 items")

### 🎨 **High Contrast Theme**
- Pure black background with bright, vibrant colors
- Excellent readability and reduced eye strain
- Color-coded JSON types:
  - **Cyan** for property names
  - **Green** for strings
  - **Blue** for numbers
  - **Yellow** for booleans
  - **Purple** for null values

### ⚡ **Easy Activation**
1. Open any JSON file in VS Code
2. Use the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Run the command: `JSON Smart Viewer: Show`
4. View your JSON in a beautiful, navigable format

### 🛡️ **Secure & Lightweight**
- No external dependencies beyond Tailwind CSS CDN
- Proper Content Security Policy implementation
- Fast rendering even for large JSON files

![JSON Smart Viewer Demo](images/json-smart-viewer-demo.png)

> **Tip**: Try it on complex API responses or configuration files to see the full power of the collapsible tree view!

## Requirements

- Visual Studio Code version 1.90.0 or higher
- Internet connection (for Tailwind CSS CDN)

## Extension Settings

This extension contributes the following command:

* `json-smart-viewer.show`: Opens the JSON Smart Viewer for the currently active JSON file

Currently, there are no configurable settings, but we're planning to add customization options in future releases.

## Usage

1. **Open a JSON file** in VS Code
2. **Open Command Palette** with `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS)
3. **Type "JSON Smart Viewer"** and select "JSON Smart Viewer: Show"
4. **Navigate your JSON** by clicking the arrow icons to expand/collapse sections

The viewer will open in a new webview panel alongside your editor, making it easy to reference both the raw JSON and the formatted view.

## Known Issues

- Large JSON files (>10MB) may experience slower initial rendering
- The extension currently requires an internet connection for Tailwind CSS styling
- Some very deeply nested JSON structures might require horizontal scrolling

If you encounter any issues, please report them on our [GitHub repository](https://github.com/your-username/json-smart-viewer).

## Roadmap

We're actively working on these exciting features:

- 🎨 **Theme customization** (light mode, custom color schemes)
- 📱 **Offline mode** (bundled CSS)
- 🔍 **Search and filter** functionality
- 📋 **Copy/export** options
- ⚙️ **Configuration settings** for indentation and colors
- 🚀 **Performance optimizations** for large files

## Release Notes

### 0.0.1 (Initial Release)

🎉 **Welcome to JSON Smart Viewer!**

**Features:**
- High-contrast, elegant JSON tree view
- Smooth expand/collapse animations
- Color-coded syntax highlighting
- Item count previews for collapsed sections
- Responsive design that works with all VS Code themes
- Secure webview implementation

**What's New:**
- Clean, professional interface with black background
- Intuitive navigation with collapsible tree structure
- Fast rendering optimized for developer workflows
- One-command activation from the Command Palette

---

## Contributing

We welcome contributions! If you'd like to help improve JSON Smart Viewer:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Support

Found this extension helpful? Consider:
- ⭐ **Starring** the repository
- 📝 **Leaving a review** in the VS Code Marketplace  
- 🐛 **Reporting bugs** or suggesting features

**Enjoy exploring your JSON with style!** ✨