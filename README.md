# LiveryLab Export

A desktop tool for livery designers that reads color-coded PSD layers and exports PNG variants. Built with Electron.

## What It Does

LiveryLab Export lets you set up a single PSD with all your livery variants (different departments, unit types, area markings, etc.) using Photoshop's layer color system, then batch-export every combination as production-ready PNGs.

- **Blue groups** become radio-button variants (pick one option per group)
- **Fuchsia/Violet layers** become toggleable checkboxes
- **Red layers** are locked (always visible), except Paint Overlay which is toggleable
- **Orange layers** are informational / conditional

## Features

- **Variant System** — Create multiple export variants (Base, Patrol, K-9, SWAT, etc.) each with their own layer visibility settings
- **Live Preview** — See your variant in real-time as you toggle layers and switch options
- **Multi-Size Export** — Export at multiple resolutions (4096, 2048, 1024, etc.) in one click
- **Multi-Department PSDs** — Optionally organize a single PSD into multiple departments, each with independent variants
- **Organize by Area** — Auto-create subfolders based on the selected area/region variant
- **Layer Effects** — Renders stroke, color overlay, drop shadow, and inner shadow effects
- **Sidecar Persistence** — Your variant configurations save automatically next to the PSD and restore on reopen
- **Template Variants** — Hover a variant and press Space to set it as the template for new variants
- **Keyboard Shortcuts** — Arrow keys cycle variants, Ctrl+O opens files, Ctrl+E exports, Delete removes variants

## PSD Setup

### Layer Color Guide

| Photoshop Color | Purpose | UI Control |
|---|---|---|
| Red | Locked / always visible | Lock icon (Paint Overlay is toggleable) |
| Blue | Variant group | Radio buttons (children = options) |
| Fuchsia | Toggle layer | Checkbox |
| Violet | Toggle layer (older PS) | Checkbox |
| Orange | Info / conditional | Info display |

### Structure

```
AO Map (Red)
Watermark (Red)
Left Side (uncolored group)
  K-9 Unit (Fuchsia) — toggle
  Area Name (Blue) — variant group
    Los Santos County
    Lafayette Parish
  Linework
Right Side (uncolored group)
  ...same structure...
Rear (uncolored group)
  ...
Paint Overlay (Red, toggleable)
Template (hidden)
```

### Multi-Department Structure

For PSDs with multiple departments, wrap each department in a top-level group:

```
AO Map (Red)
Watermark (Red)
Sheriff Department (uncolored group)
  Left Side / Right Side / Rear...
Fire Department (uncolored group)
  Left Side / Right Side / Rear...
Paint Overlay (Red)
Template (hidden)
```

The app auto-detects this structure and shows a department tab bar.

### Same-Name Deduplication

Layers with the same name across different sides (e.g., "K-9 Unit" in both Left Side and Right Side) show as a single toggle — changing one changes all matching layers.

Variant groups with identical option sets (e.g., "Area Star", "Area Name", "Area Badge" all containing the same region options) are merged into one radio group.

## Installation

### From Release

Download the latest release from the [Releases](https://github.com/ttolerantss/psd-exporter/releases) page and run `LiveryLab Export.exe`.

### From Source

```bash
git clone https://github.com/ttolerantss/psd-exporter.git
cd psd-exporter
npm install
npm start
```

### Build Executable

```bash
npm run build:dir    # Unpacked exe in dist/win-unpacked/
npm run build        # NSIS installer in dist/
```

## Keyboard Shortcuts

| Key | Action |
|---|---|
| Arrow Up/Down | Cycle through variants |
| Ctrl+Click | Multi-select variants |
| Ctrl+J | Duplicate selected variant(s) |
| Ctrl+C | Copy selected variant(s) to clipboard |
| Ctrl+V | Paste variant(s) from clipboard (works cross-department) |
| Space (hover variant) | Set/unset as template for new variants |
| Delete | Delete selected variant |
| Ctrl+O | Open PSD file |
| Ctrl+E | Export all variants |
| Ctrl+H | Toggle help |
| Escape | Close overlay/modal |

## Tech Stack

- **Electron** — Desktop framework
- **ag-psd** — PSD file parsing
- **esbuild** — JS bundling
- **electron-builder** — Packaging

## License

ISC
