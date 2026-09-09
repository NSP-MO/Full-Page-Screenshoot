# Privacy Policy

**Effective Date:** September 9, 2026  
**Last Updated:** September 9, 2026

This Privacy Policy describes how the **Full Page Screenshot** browser extension ("Extension") handles user information and data.

---

## 1. Overview

Full Page Screenshot is designed as a client-side productivity utility for capturing full-page webpage screenshots, annotating images, and exporting them to PNG or PDF formats. All capture, stitching, editing, and conversion operations are performed entirely within the user's local browser runtime.

---

## 2. Information Collection and Storage

The Extension does not collect, transmit, sell, or share any personal information, user data, or browsing records with external parties or remote servers.

- **No Remote Data Transmission:** The Extension does not maintain remote servers, databases, or external telemetry pipelines. No analytics, tracking pixels, or third-party monitoring scripts are embedded.
- **No Browsing History Collection:** The Extension does not log, track, or retain browsing activity, visited URLs, search queries, or page contents beyond the active webpage selected by the user for capturing.
- **Local Ephemeral Storage:** Captured image slices, stitched canvas buffers, and annotation states are temporarily retained within the browser's local storage (`chrome.storage.local`) solely to facilitate preview and export functionality. This data remains on the user's local machine and is discarded when the session ends or when cleared by the user.

---

## 3. Browser Permissions

The Extension requests specific browser permissions strictly to perform its core functionalities:

- **`activeTab`**: Allows the Extension to interact with the currently focused tab when the user explicitly clicks the toolbar action icon.
- **`scripting`**: Injects a temporary helper script into the active webpage to calculate layout dimensions, suppress scrollbars, and sequentially scroll the document during capture.
- **`downloads`**: Enables saving exported files (PNG images, Single-Page PDFs, and Multi-Page A4 PDFs) directly to the user's local file system.
- **`storage` and `unlimitedStorage`**: Provides sufficient local browser memory allocation to assemble and preserve high-resolution full-page canvas data during an active session.
- **`clipboardWrite`**: Allows the Extension to copy the rendered screenshot image directly to the system clipboard upon capture.
- **Host Permissions (`<all_urls>`)**: Enables the Extension to execute the sequential scroll capture process across arbitrary web domains when initiated by the user. The Extension never accesses pages in the background without user initiation.

---

## 4. Third-Party Services and Remote Code

The Extension does not load external scripts, dynamic modules, remote stylesheets, or third-party APIs. All code and visual assets required for operation are self-contained within the installed extension package.

---

## 5. Security

Because all processing occurs within the user's browser sandbox, captured screenshots and annotated documents never leave the local environment unless explicitly exported or downloaded by the user.

---

## 6. Policy Changes

Any future updates to this Privacy Policy will be reflected directly within this document and published in the extension repository.

---

## 7. Contact Information

For inquiries, bug reports, or questions regarding this Privacy Policy, please open an issue in the official project repository:

- **Repository:** [https://github.com/NSP-MO/Full-Page-Screenshoot](https://github.com/NSP-MO/Full-Page-Screenshoot)
