# Full Page Screenshoot

A high-performance Chromium / Brave browser extension designed for one-click, pixel-perfect full webpage screen captures. Built on native browser compositor APIs with automatic sequential scrolling, universal single-page application (SPA) container detection, and an integrated preview viewer featuring continuous single-page and paginated multi-page A4 PDF export, lossless PNG downloading, clipboard copying, and redaction tools (Gaussian Blur and Mosaic Censor).


---

## Key Features

### 1. Native Compositor Capture Engine
- **100% Native Visual Fidelity**: Renders modern CSS Color Module 4 (`color(srgb ...)`, `oklch()`, `lab()`), WebGL, Canvas, custom typography, SVGs, and dynamic stylesheets without relying on fragile third-party DOM parsers.
- **Strict Rate-Limit Protection**: Enforces an optimized 520 ms pipelined capture interval with exponential backoff, preventing Chromium `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` quota errors.
- **Dynamic Fixed Header Suppression**: Automatically detects and hides `position: fixed` and `position: sticky` elements on subsequent scroll slices to prevent visual duplication.
- **Invisible Scrollbars**: Hides browser scrollbars visually during capture without locking root overflow scrolling.

### 2. Universal Scroller & SPA Container Detection
- **Standard Document Mode**: Captures long websites (GitHub, documentation, news, portfolio sites) by coordinating document-level scrolling from `y = 0` to `scrollHeight`.
- **Nested Container Mode**: Automatically detects and scrolls internal containers in complex web applications:
  - **Google Docs**: Targets `.kix-appview-editor` / `.goog-scrollable-container` and triggers synthetic scroll events for virtualized canvas rendering.
  - **Gmail**: Detects email thread scrollable containers.
  - **Productivity SPAs**: Notion, Slack, Discord, Trello, and chat interfaces.
- **Container-Aware Cropping**: Clips slices to container boundaries, eliminating repeated sidebars and top toolbars.

### 3. Integrated Preview & Annotation Workspace
- **VS Code Dark Theme**: Clean interface styled in accordance with the `#1f1f1f` palette.
- **Interactive Redaction & Markup Tools**:
  - **Smooth Gaussian Blur (`G`)**: GPU-accelerated blur filter with edge margin padding for soft redaction.
  - **Pixelated Mosaic Censor (`M` / `B`)**: Classic pixelation block censor for masking sensitive text or credentials.
  - **Shapes & Drawing**: Rectangle Box (`R`), Arrow Pointer (`A`), Freehand Pen (`P`), Text Notes (`T`).
  - **Palette**: Monochrome and white palette (`#ffffff`, `#cbd5e1`, `#64748b`, `#0f172a`).
  - **History Management**: Multi-step undo (`Ctrl+Z`) and canvas clear.

### 4. Versatile Export Handlers
- **Lossless PNG Export**: Generates full-resolution PNG images with flattened annotation layers.
- **JPEG Export**: Configurable quality level.
- **Single-Page Continuous PDF**: Compliant standard PDF 1.4 containing the entire webpage in one continuous canvas stream.
- **Multi-Page Paginated A4 PDF**: Divides long screenshots into standard A4 pages with printable margins for documentation and printing.
- **Direct Clipboard Copy**: Copies high-resolution PNG data directly to system clipboard via the Clipboard API.

---

## Directory Structure

```
f:/full-page-screenshot/
├── manifest.json              # Manifest V3 extension configuration
├── background/
│   └── service-worker.js      # Background scheduler, rate limiting, and session persistence
├── content/
│   ├── content.js             # Universal scroller engine and DOM measurement
│   └── content.css            # Non-blocking scrollbar suppression styles
├── popup/
│   ├── popup.html             # Extension popup interface
│   ├── popup.css              # Popup styling (VS Code theme)
│   └── popup.js               # Capture trigger and preference management
├── viewer/
│   ├── viewer.html            # Full-page preview workspace
│   ├── viewer.css             # Viewer interface styling (VS Code #1f1f1f)
│   └── viewer.js              # Canvas stitching, Gaussian blur, PDF generator, and export
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── exec/
    ├── generate_icons.py       # Icon generator script
    ├── verify_extension.py     # Integrity validation script
    └── run_setup.ipynb         # Task execution notebook
```

---

## Installation & Setup

1. Clone or download the repository:
   ```bash
   git clone https://github.com/NSP-MO/Full-Page-Screenshoot.git
   ```
2. Open your Chromium-based browser (Brave, Google Chrome, Microsoft Edge).
3. Navigate to `brave://extensions` (or `chrome://extensions`).
4. Enable **Developer mode** toggle in the top right corner.
5. Click **Load unpacked** and select the `f:/full-page-screenshot` directory.
6. The extension icon will appear in your browser toolbar ready for one-click capture.

---

## Usage

1. Open any webpage or document (e.g. GitHub repository, Google Docs, Gmail thread).
2. Click the **Full Page Screenshoot** icon in the browser toolbar.
3. The extension will automatically scroll and capture all slices.
4. A new preview tab will open instantly with zoom, Gaussian blur/mosaic redaction tools, and export options (PNG, Continuous PDF, Multi-Page A4 PDF, Copy to Clipboard).
