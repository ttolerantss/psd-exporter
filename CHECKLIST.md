# LiveryLab Export Tool - Phased Build Checklist

> Each phase requires sign-off before moving to the next.
> Decisions locked in from Q&A are marked with a key emoji.

## Decisions Log

| Decision | Choice |
|----------|--------|
| Tech stack | Electron + JavaScript (matches livery-viewer) |
| Base variant | Always locked in, cannot be deleted |
| Variant persistence | Save to sidecar JSON next to PSD, auto-restore on reopen |
| Error handling | Toast notifications (non-blocking, auto-dismiss) |
| PSD rendering | Best-effort with ag-psd, warn user on rendering issues |
| Live preview | Yes, rendered preview that updates on layer toggle |
| Paint Overlay | Visible by default, toggleable per variant |
| Variant reordering | Deferred to future update |

---

## Phase 1: Project Scaffolding & Build Pipeline

**Goal:** Bootable Electron app with dev workflow and build config.

- [ ] Initialize npm project with `package.json`
- [ ] Install core dependencies: `electron`, `esbuild`, `ag-psd`, `electron-builder`
- [ ] Create directory structure:
  ```
  src/
    main/main.js          # Electron main process
    renderer/
      index.html          # App shell
      renderer.js         # Renderer entry point
    assets/               # Icons, logos
  ```
- [ ] Set up Electron main process (window creation, IPC boilerplate)
- [ ] Configure esbuild bundling (mirroring livery-viewer's approach)
- [ ] Add npm scripts: `dev`, `build`, `package`
- [ ] Verify app launches with a blank window + custom title bar
- [ ] Set up `.gitignore` and initialize git repo

**Sign-off criteria:** App launches, dev workflow works (edit → rebuild → see changes).

---

## Phase 2: Design System & App Shell

**Goal:** App looks like it belongs in the LiveryLab suite. All panels laid out, no functionality yet.

- [ ] Port design tokens from livery-viewer's `DESIGN_LANGUAGE.md`:
  - Geist font import
  - Color palette (backgrounds, text, borders, brand blues)
  - Spacing system (8px grid)
  - Border radius, transitions, z-index scale
- [ ] Build the app shell layout matching the UI mockup:
  - Custom title bar (minimize, close)
  - File drop zone / browse area at top
  - Two-column body: Variants panel (left) + Layer Settings panel (right)
  - Bottom bar: variant name input, export options, export button
- [ ] Style all UI elements (buttons, inputs, checkboxes, radio buttons, scrollbars)
- [ ] Implement custom window controls (minimize, close) via IPC
- [ ] Add placeholder content in each panel to verify layout

**Sign-off criteria:** App visually matches the mockup and is consistent with livery-viewer styling. All panels visible with placeholder data.

---

## Phase 3: PSD Loading & Layer Parsing

**Goal:** User can load a PSD and see its layer tree parsed by color codes.

- [ ] Implement drag-and-drop file input (accept `.psd` only)
- [ ] Implement "Browse" button file picker (fallback)
- [ ] Parse PSD using `ag-psd` and extract layer tree
- [ ] Detect layer color codes and classify:
  | Color | Classification | UI Treatment |
  |-------|---------------|--------------|
  | Red | Locked/hidden | Grayed out with lock icon |
  | Blue | Variant option | Radio button group |
  | Orange | Edit-needed | Info indicator |
  | Fuchsia | Toggleable | Checkbox |
  | None | Regular layer | Not shown in settings panel |
- [ ] Handle nested groups up to 2 levels deep
- [ ] Display parsed layers in the Layer Settings panel, grouped by type
- [ ] Display filename prominently after loading
- [ ] Validate required layers (AO Map, Watermark, Template, Paint Overlay) and show toast warning if missing
- [ ] Handle error cases: invalid file, corrupt PSD, unsupported format

**Sign-off criteria:** A real PSD loads, layers appear correctly classified in the settings panel, required layers are validated.

---

## Phase 4: Variant System

**Goal:** User can create, select, edit, and delete variants. Layer states are tracked per variant.

- [ ] Auto-create "Base" variant on PSD load:
  - All fuchsia layers OFF
  - Blue groups set to first option
  - Red layers always hidden
  - Paint Overlay visible
- [ ] Implement variant data model:
  ```js
  {
    id: string,
    name: string,
    isBase: boolean,
    layerStates: {
      [layerId]: { visible: boolean, selectedOption?: string }
    }
  }
  ```
- [ ] Build Variants panel (left column):
  - List all variants with names
  - Highlight selected variant
  - Click to select
- [ ] "Add Variant" button:
  - Creates copy of Base variant (not current selection)
  - Opens with default name "New Variant" (editable)
  - Auto-selects the new variant
- [ ] "Delete" button:
  - Deletes selected variant
  - Base variant has delete button disabled / hidden
  - Confirm before deleting (toast or small prompt)
- [ ] Layer Settings panel reacts to selected variant:
  - Fuchsia checkboxes reflect variant's toggle states
  - Blue radio buttons reflect variant's selections
  - Red layers always shown as locked
  - Orange layers shown as informational
- [ ] Toggling a checkbox or radio button updates the selected variant's state
- [ ] Variant name input at bottom bound to selected variant's name

**Sign-off criteria:** Can create multiple variants, toggle layers independently per variant, delete non-base variants, rename variants. Switching between variants updates the settings panel correctly.

---

## Phase 5: Live Preview

**Goal:** Rendered PSD preview updates in real-time as layers are toggled.

- [ ] Render PSD composite using `ag-psd` with current variant's layer visibility
- [ ] Display rendered preview (decide placement — could be above layer settings or as a toggleable panel)
- [ ] Update preview when:
  - A layer toggle changes
  - A variant option (blue) changes
  - User switches between variants
- [ ] Handle rendering limitations gracefully:
  - Detect Smart Objects with transformations
  - Show toast warning if rendering may be inaccurate
  - Log specific rendering issues to console
- [ ] Optimize rendering performance:
  - Debounce rapid toggle changes
  - Show loading indicator during re-render
  - Cache layer composites where possible
- [ ] Preview should respect layer blend modes (best-effort via ag-psd)

**Sign-off criteria:** Preview displays the PSD. Toggling layers visibly changes the preview. Rendering warnings appear for unsupported features. Performance is acceptable (< 2s re-render).

---

## Phase 6: Export Engine

**Goal:** User can export one or all variants as correctly-named PNGs.

- [ ] Implement single-variant export:
  - Apply variant's layer visibility states
  - Render composite at 4096x4096
  - Save as PNG
- [ ] Implement export naming convention:
  - Base variant: `[PSD filename].png`
  - Other variants: `[PSD filename] [variant name].png`
  - Example: `2020 FPIU.psd` + "K-9 Ghosted" → `2020 FPIU K-9 Ghosted.png`
- [ ] 2048x2048 export option:
  - Checkbox: "Also export 2048px"
  - When checked, export a second copy scaled to 2048x2048
  - Naming: `[PSD filename] [variant name] 2048.png` (or subfolder?)
- [ ] Output directory selection:
  - "Browse" button for output folder
  - Remember last used directory (persist in app settings)
  - Display current output path
- [ ] "Export All Variants" button:
  - Iterates through all variants
  - Exports each with correct naming
  - Shows progress (toast or progress bar)
  - Summary toast on completion: "Exported 5 variants to F:\Exports\"
- [ ] Handle export errors gracefully (disk full, permission denied, etc.)

**Sign-off criteria:** Can export single variant and all variants. Files are correctly named. 4096 and 2048 sizes work. Output directory is remembered between sessions.

---

## Phase 7: Persistence & Polish

**Goal:** Variant configs persist, UX is polished, edge cases handled.

- [ ] Implement sidecar JSON persistence:
  - On variant change, save to `[PSD filename].liverylab.json` next to PSD
  - On PSD load, check for sidecar file and restore variants
  - Handle mismatched sidecar (PSD layers changed since last save)
- [ ] Toast notification system:
  - Success: green accent, auto-dismiss 3s
  - Warning: yellow accent, auto-dismiss 5s
  - Error: red accent, stays until dismissed
  - Stack multiple toasts vertically
- [ ] UX polish:
  - Keyboard shortcuts (Ctrl+O open, Ctrl+E export all, Del delete variant)
  - Empty state for variants panel ("Load a PSD to get started")
  - Loading spinner for PSD parsing
  - Drag-and-drop visual feedback (border highlight on drag over)
- [ ] Edge case handling:
  - Re-loading a different PSD clears current state
  - Very large PSDs (> 500MB) — show warning, don't freeze
  - PSD with no color-coded layers — inform user
  - Duplicate variant names — warn or auto-suffix

**Sign-off criteria:** Variants survive app restart (via sidecar JSON). Toasts work for all scenarios. App feels polished and handles edge cases without crashing.

---

## Phase 8: Packaging & Distribution

**Goal:** Standalone `.exe` that runs on any Windows machine.

- [ ] Configure `electron-builder` for Windows:
  - NSIS installer or portable `.exe`
  - App icon and metadata
  - File association for `.psd` (optional)
- [ ] ASAR packaging with necessary unpackings (ag-psd, etc.)
- [ ] Test packaged app on clean Windows install (no Node.js)
- [ ] Verify all features work in packaged build:
  - PSD loading (drag-drop and browse)
  - Layer parsing and preview
  - Variant management
  - Export (single and all)
  - Sidecar persistence
  - Output directory memory
- [ ] Optimize bundle size (exclude unnecessary dependencies)
- [ ] Create app icon consistent with LiveryLab branding

**Sign-off criteria:** `.exe` installs and runs on Windows without Node.js. All features work. Bundle size is reasonable.

---

## Future Phases (Post-Launch)

These are explicitly deferred and not part of the initial build:

- [ ] Variant drag-to-reorder
- [ ] Merge into unified LiveryLab app
- [ ] Batch processing multiple PSDs
- [ ] Unit number handling
- [ ] Preset templates for common variant patterns
- [ ] Auto-update mechanism (electron-updater)

---

## Progress Tracker

| Phase | Status | Sign-off |
|-------|--------|----------|
| 1. Project Scaffolding | Not Started | [ ] |
| 2. Design System & Shell | Not Started | [ ] |
| 3. PSD Loading & Parsing | Not Started | [ ] |
| 4. Variant System | Not Started | [ ] |
| 5. Live Preview | Not Started | [ ] |
| 6. Export Engine | Not Started | [ ] |
| 7. Persistence & Polish | Not Started | [ ] |
| 8. Packaging & Distribution | Not Started | [ ] |
