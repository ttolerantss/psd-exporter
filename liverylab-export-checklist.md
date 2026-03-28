# LiveryLab Export Tool - Claude Code Checklist

## Reference Application

Use `F:\Projects\livery-viewer` (LiveryLab Repaint) as the design reference. Pull from it:
- Font choices
- Color palette
- UI spacing and layout patterns
- General component styling
- Any shared styles/constants files

Goal is visual consistency so these apps can eventually merge into a unified LiveryLab suite.

---

## Core Functionality

### 1. File Input
- Drag-and-drop or browse to select a PSD file
- Display the filename prominently once loaded

### 2. Layer Parsing
Read PSD layer/group structure and identify layers by their color coding:

| Color | Meaning | Behavior |
|-------|---------|----------|
| **Red** | Locked/hidden | Always hidden on export (Template, AO Map, Watermark) |
| **Blue** | Variant options | Mutually exclusive choices (e.g., IRL name vs Los Santos) |
| **Orange** | Edit-needed | Display to user, informational only |
| **Fuchsia** | Toggleable | Independent on/off (e.g., K-9 Unit, Ghosted) |

- Display layer/group names to the user even though logic runs on colors
- Handle nesting up to 2 levels deep:
  ```
  📁 Side Group
     📁 Decal Group (color-coded)
        📁 Variant A (for blue groups)
        📁 Variant B
  ```

### 3. Variant System

**On PSD Load:**
- Automatically create a "Base" variant
- All fuchsia (toggleable) layers set to OFF
- Blue (variant) groups set to first option as default
- Red layers always hidden
- Paint Overlay visible

**Adding New Variants:**
- User clicks "Add Variant" button
- New variant starts as a copy of the Base (not the currently selected variant)
- User can toggle fuchsia layers on/off
- User can select which blue variant options are active
- User names the variant (e.g., "K-9", "K-9 Ghosted", "Speed Enforcement")

**Variant Management:**
- List all variants in a panel
- Click to select and view/edit a variant's settings
- Delete variants (except Base?)
- Reorder variants (optional, nice-to-have)

### 4. Export Configuration UI
- Show all fuchsia layers as independent checkboxes (can toggle multiple)
- Show all blue groups as radio button sets (pick one variant per group)
- Show red layers as grayed-out/locked indicators (user sees them but can't toggle)
- Show orange layers as visible indicators (informational)

### 5. Export Naming
- Each variant has its own name set by the user
- Export filename = `[PSD filename] [variant name].png`
- Example: `2020 FPIU.psd` + variant named "K-9 Ghosted" → `2020 FPIU K-9 Ghosted.png`
- Base variant exports as just the PSD filename: `2020 FPIU.png`

### 6. Export Output
- Export as PNG at 4096×4096
- Checkbox option to also export a 2048×2048 version (scaled down)
- Let user choose output directory (remember last used)
- "Export All" exports every variant in the list

### 7. Required Layers
Every file will have these layers (app can validate/warn if missing):
- AO Map (red)
- Watermark (red)
- Template (red)
- Paint Overlay

---

## Technical Requirements

### 1. Standalone Application
- Package as standalone `.exe` for Windows
- No Photoshop installation required
- Use Python with PyInstaller or similar for packaging

### 2. PSD Rendering
- Attempt Photoshop-free rendering using `psd-tools` or similar library
- Must correctly handle:
  - Layer visibility toggling
  - Nested groups (2 levels)
  - Smart Objects with transformations (rotation, horizontal flip)
  - Blend modes and effects

**⚠️ Risk Note:** Photoshop-free rendering of complex PSDs with nested/transformed Smart Objects may have limitations. If rendering proves unreliable, document specific issues and we'll revisit Photoshop integration as a fallback.

### 3. Design Consistency
- Reference `F:\Projects\livery-viewer` for all visual styling
- Extract or mirror any design tokens (colors, fonts, spacing) so both apps stay consistent
- Structure code so shared styles can eventually become a common module

---

## UI Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  LiveryLab Export                                          [—][×]│
├─────────────────────────────────────────────────────────────────┤
│  [Drop PSD here or click to browse]                             │
│  Current file: 2020 FPIU.psd                                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  VARIANTS                    │  LAYER SETTINGS                  │
│  ┌─────────────────────────┐ │                                  │
│  │ ► Base                  │ │  Toggleable (select any):        │
│  │   K-9                   │ │    ☐ K-9 Unit                    │
│  │   K-9 Ghosted           │ │    ☐ Ghosted                     │
│  │   Speed Enforcement     │ │    ☐ Speed Enforcement           │
│  │                         │ │                                  │
│  │                         │ │  Variants (pick one each):       │
│  │                         │ │    Department Name:              │
│  │                         │ │      ◉ Los Santos                │
│  │                         │ │      ○ Philadelphia PD           │
│  │                         │ │                                  │
│  │                         │ │  Locked (always hidden):         │
│  │                         │ │    🔒 Template                   │
│  │                         │ │    🔒 AO Map                     │
│  │                         │ │    🔒 Watermark                  │
│  └─────────────────────────┘ │                                  │
│  [ + Add Variant ] [ Delete ]│                                  │
│                              │                                  │
├─────────────────────────────────────────────────────────────────┤
│  Variant name: [K-9 Ghosted                        ]            │
│                                                                 │
│  ☑ 4096px    ☑ Also export 2048px                               │
│  Output folder: [F:\Exports\                       ] [Browse]   │
│                                                                 │
│                         [ Export All Variants ]                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Future Considerations (not for initial build)

- Merge into unified LiveryLab app alongside Repaint viewer
- Save/load variant configurations per PSD (persist between sessions)
- Batch processing multiple PSD files
- Unit number handling (TBD on implementation approach)
- Preset templates for common variant patterns

---

## Questions for Development

1. Should the Base variant be deletable, or always locked in?
2. When a PSD is re-opened, should it remember previously created variants, or start fresh?
3. Any specific error handling preferences (toast notifications, modal dialogs, etc.)?
