const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// Patch ag-psd to support fuchsia (Photoshop CC 2020+ added it as color index 8)
const agPsdHelpers = require('ag-psd/dist/helpers');
if (!agPsdHelpers.layerColors.includes('fuchsia')) {
  agPsdHelpers.layerColors.push('fuchsia');
}

const { readPsd } = require('ag-psd');

// ============================================
// State
// ============================================

let currentPsd = null;
let currentFilePath = null;
let classifiedLayers = null;

// Variant system
let variants = [];          // Array of variant objects
let selectedVariantId = null; // Currently selected variant ID
let nextVariantId = 1;

// Export sizes (pixel widths)
let exportSizes = [4096];

// Output directory
let outputDirectory = null;
let isExporting = false;

// Template variant for "Add Variant" (defaults to base)
let templateVariantId = null; // null = use base
let hoveredVariantId = null;

// Multi-select for variant list
let selectedVariantIds = new Set(); // additional selections beyond the primary
let variantClipboard = []; // copied variant layerStates for cross-department paste

// Export option: organize by area subfolder
let organizeByArea = false;

// Multi-department support
let departments = null; // null = single-dept, otherwise array of { name, psdLayer, classifiedLayers, variants, nextVariantId, selectedVariantId, templateVariantId }
let selectedDepartmentIndex = 0;

// ============================================
// Sidecar JSON Persistence
// ============================================

function getSidecarPath() {
  if (!currentFilePath) return null;
  const dir = path.dirname(currentFilePath);
  const stem = path.basename(currentFilePath, path.extname(currentFilePath));
  const folder = path.join(dir, 'LiveryLab Export Saves');
  return path.join(folder, `${stem}.liverylab.json`);
}

// Legacy sidecar path (for migration from old format)
function getLegacySidecarPath() {
  if (!currentFilePath) return null;
  const dir = path.dirname(currentFilePath);
  const stem = path.basename(currentFilePath, path.extname(currentFilePath));
  return path.join(dir, `${stem}.liverylab.json`);
}

let sidecarDebounceTimer = null;
function saveSidecar() {
  clearTimeout(sidecarDebounceTimer);
  sidecarDebounceTimer = setTimeout(() => {
    const sidecarPath = getSidecarPath();
    if (!sidecarPath) return;

    try {
      // Ensure .liverylab folder exists
      const folder = path.dirname(sidecarPath);
      if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

      let data;
      if (departments) {
        // Save current department state back before serializing
        saveDepartmentState();
        data = {
          version: 2,
          departments: {},
          exportSizes,
          outputDirectory,
          organizeByArea,
        };
        for (const dept of departments) {
          data.departments[dept.name] = {
            variants: dept.variants,
            nextVariantId: dept.nextVariantId,
          };
        }
      } else {
        data = {
          variants,
          nextVariantId,
          exportSizes,
          outputDirectory,
          organizeByArea,
        };
      }
      fs.writeFileSync(sidecarPath, JSON.stringify(data, null, 2), 'utf-8');

      // Clean up legacy sidecar if it exists
      const legacyPath = getLegacySidecarPath();
      if (legacyPath && fs.existsSync(legacyPath)) {
        try { fs.unlinkSync(legacyPath); } catch (_) {}
      }
    } catch (err) {
      console.error('Failed to save sidecar:', err);
    }
  }, 300);
}

function loadSidecar() {
  let sidecarPath = getSidecarPath();
  if (!sidecarPath) return false;

  try {
    // Try new location first, then fall back to legacy
    if (!fs.existsSync(sidecarPath)) {
      const legacyPath = getLegacySidecarPath();
      if (legacyPath && fs.existsSync(legacyPath)) {
        sidecarPath = legacyPath;
      } else {
        return false;
      }
    }

    const raw = fs.readFileSync(sidecarPath, 'utf-8');
    const data = JSON.parse(raw);

    // Reconcile variant states against current PSD layers
    function reconcileVariants(variantList, cl) {
      const prevClassified = classifiedLayers;
      classifiedLayers = cl;
      const currentToggleNames = new Set(getUniqueToggleLayers().map(l => l.name));
      const currentGroupNames = new Set(getUniqueVariantGroups().map(g => g.name));
      const allCurrentNames = new Set([...currentToggleNames, ...currentGroupNames]);
      let mismatch = false;

      for (const variant of variantList) {
        if (!variant.layerStates) variant.layerStates = {};
        for (const key of Object.keys(variant.layerStates)) {
          if (!allCurrentNames.has(key)) { delete variant.layerStates[key]; mismatch = true; }
        }
        for (const name of currentToggleNames) {
          if (!(name in variant.layerStates)) {
            variant.layerStates[name] = { visible: isPaintOverlay(name) };
            mismatch = true;
          }
        }
        for (const group of getUniqueVariantGroups()) {
          if (!(group.name in variant.layerStates)) {
            variant.layerStates[group.name] = { selectedOption: group.options[0]?.name || null };
            mismatch = true;
          }
        }
        syncMergedVariantGroups(variant.layerStates);
      }
      classifiedLayers = prevClassified;
      return mismatch;
    }

    let mismatch = false;

    if (data.version === 2 && data.departments && departments) {
      // Multi-department sidecar
      for (const dept of departments) {
        const saved = data.departments[dept.name];
        if (saved && Array.isArray(saved.variants) && saved.variants.length > 0) {
          mismatch = reconcileVariants(saved.variants, dept.classifiedLayers) || mismatch;
          dept.variants = saved.variants;
          dept.nextVariantId = saved.nextVariantId || (Math.max(...saved.variants.map(v => v.id)) + 1);
          dept.selectedVariantId = saved.variants[0].id;
        } else {
          // No saved data for this department — create fresh base
          const prevCl = classifiedLayers;
          classifiedLayers = dept.classifiedLayers;
          const base = createBaseVariant();
          dept.variants = [base];
          dept.nextVariantId = nextVariantId;
          dept.selectedVariantId = base.id;
          classifiedLayers = prevCl;
          mismatch = true;
        }
        dept.templateVariantId = null;
      }
      loadDepartmentIntoGlobals(0);
    } else if (!departments) {
      // Single-department sidecar
      if (!Array.isArray(data.variants) || data.variants.length === 0) return false;
      mismatch = reconcileVariants(data.variants, classifiedLayers);
      variants = data.variants;
      nextVariantId = data.nextVariantId || (Math.max(...variants.map(v => v.id)) + 1);
      selectedVariantId = variants[0].id;
    } else {
      // Mismatch: sidecar is single-dept but PSD is multi-dept (or vice versa)
      showToast('PSD structure changed — creating fresh variants', 'warning', 5000);
      return false;
    }

    if (Array.isArray(data.exportSizes) && data.exportSizes.length > 0) {
      exportSizes = data.exportSizes;
    }

    if (data.outputDirectory) {
      outputDirectory = data.outputDirectory;
      document.getElementById('output-path').textContent = data.outputDirectory;
    }

    if (data.organizeByArea) {
      organizeByArea = true;
      document.getElementById('chk-organize-by-area').checked = true;
    }

    if (mismatch) {
      showToast('PSD layers changed since last save — defaults applied for new layers', 'warning', 5000);
    }

    return true;
  } catch (err) {
    console.error('Failed to load sidecar:', err);
    return false;
  }
}

// ============================================
// Window Controls
// ============================================

document.getElementById('btn-minimize').addEventListener('click', () => {
  ipcRenderer.send('minimize-window');
});

document.getElementById('btn-maximize').addEventListener('click', () => {
  ipcRenderer.send('maximize-window');
});

document.getElementById('btn-close').addEventListener('click', () => {
  ipcRenderer.send('close-window');
});

// ============================================
// Toast System
// ============================================

function showToast(message, type = 'success', duration = 3000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  const dismissDelay = type === 'error' ? 8000 : duration;
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease-out forwards';
    toast.addEventListener('animationend', () => toast.remove());
  }, dismissDelay);
}

window.showToast = showToast;

// ============================================
// Variant Data Model
// ============================================

function createBaseVariant() {
  const layerStates = {};

  // Fuchsia/violet toggles: all OFF by default, except Paint Overlay
  for (const layer of getUniqueToggleLayers()) {
    layerStates[layer.name] = { visible: isPaintOverlay(layer.name) };
  }

  // Blue variant groups: first option selected by default
  for (const group of getUniqueVariantGroups()) {
    layerStates[group.name] = { selectedOption: group.options[0]?.name || null };
  }

  return {
    id: nextVariantId++,
    name: 'Base',
    isBase: true,
    layerStates,
  };
}

function createNewVariant(name) {
  // Copy from template variant, or fall back to base
  const source = (templateVariantId != null && variants.find(v => v.id === templateVariantId))
    || variants.find(v => v.isBase);
  if (!source) return null;

  return {
    id: nextVariantId++,
    name: name || 'New Variant',
    isBase: false,
    layerStates: JSON.parse(JSON.stringify(source.layerStates)),
  };
}

function getUniqueToggleLayers() {
  if (!classifiedLayers) return [];
  const seen = new Set();
  return classifiedLayers.toggle.filter(l => {
    const key = l.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getUniqueVariantGroups() {
  if (!classifiedLayers) return [];
  const seen = new Set();
  return classifiedLayers.variant.filter(g => {
    const key = g.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Sync merged variant groups: groups with identical option sets should share the same selection
function syncMergedVariantGroups(layerStates) {
  const groups = getUniqueVariantGroups();
  const mergedMap = new Map();
  for (const group of groups) {
    const optionKey = getOptionMergeKey(group);
    if (!mergedMap.has(optionKey)) mergedMap.set(optionKey, []);
    mergedMap.get(optionKey).push(group.name);
  }
  for (const groupNames of mergedMap.values()) {
    if (groupNames.length <= 1) continue;
    // Find the first group that has a valid selection
    let selected = null;
    for (const gn of groupNames) {
      const state = layerStates[gn];
      if (state && state.selectedOption) { selected = state.selectedOption; break; }
    }
    if (selected) {
      for (const gn of groupNames) {
        layerStates[gn] = { selectedOption: selected };
      }
    }
  }
}

function getSelectedVariant() {
  return variants.find(v => v.id === selectedVariantId) || null;
}

// ============================================
// PSD Loading
// ============================================

async function loadPsdFile(filePath) {
  if (!filePath || !filePath.toLowerCase().endsWith('.psd')) {
    showToast('Please select a valid PSD file', 'error');
    return;
  }

  try {
    const buffer = fs.readFileSync(filePath);
    const psd = readPsd(buffer, {
      skipCompositeImageData: true,
      skipThumbnail: true
    });

    currentPsd = psd;
    currentFilePath = filePath;
    idCounter = 0;

    const fileName = path.basename(filePath);
    document.getElementById('file-name').textContent = fileName;
    document.getElementById('drop-zone').classList.add('file-loaded');

    // Detect departments
    const detectedDepts = detectDepartments(psd.children || []);

    if (detectedDepts) {
      // Multi-department mode
      // Classify shared top-level layers (Paint Overlay etc.) to merge into each dept
      const sharedClassified = classifyLayers(
        (psd.children || []).filter(l => !detectedDepts.some(d => d.name === l.name)),
        0
      );

      departments = detectedDepts.map(dept => {
        idCounter = 0; // reset per department for consistent IDs
        const deptClassified = classifyLayers(dept.psdLayer.children || [], 0);
        // Merge shared toggles (Paint Overlay) into department
        deptClassified.toggle.push(...sharedClassified.toggle.map(t => ({ ...t })));
        deptClassified.locked.push(...sharedClassified.locked.map(l => ({ ...l })));
        return {
          name: dept.name,
          psdLayer: dept.psdLayer,
          classifiedLayers: deptClassified,
          variants: [],
          nextVariantId: 1,
          selectedVariantId: null,
          templateVariantId: null,
        };
      });

      selectedDepartmentIndex = 0;

      // Try to restore from sidecar
      const restored = loadSidecar();
      if (!restored) {
        // Create fresh base variants for each department
        for (const dept of departments) {
          loadDepartmentIntoGlobals(departments.indexOf(dept));
          const base = createBaseVariant();
          dept.variants = [base];
          dept.nextVariantId = nextVariantId;
          dept.selectedVariantId = base.id;
        }
        exportSizes = [psd.width];
      }

      // Load first department into globals
      loadDepartmentIntoGlobals(0);

      // Validate using first department + shared
      validateRequiredLayers(classifiedLayers);

      console.log(`Multi-department PSD: ${departments.map(d => d.name).join(', ')}`);
    } else {
      // Single-department mode
      departments = null;
      classifiedLayers = classifyLayers(psd.children || []);

      validateRequiredLayers(classifiedLayers);

      const restored = loadSidecar();
      if (!restored) {
        variants = [];
        nextVariantId = 1;
        const base = createBaseVariant();
        variants.push(base);
        selectedVariantId = base.id;
        exportSizes = [psd.width];
      }
    }

    // Render everything
    renderDepartmentBar();
    renderVariantList();
    renderLayerSettings();
    updateBottomBar();
    renderExportSizes();

    // Show preview and render
    document.getElementById('preview-container').style.display = '';
    renderPreview();

    // Enable buttons
    document.getElementById('btn-add-variant').disabled = false;
    document.getElementById('btn-export-all').disabled = false;

    showToast(`Loaded ${fileName}`, 'success');
    console.log('PSD loaded:', fileName, `${psd.width}x${psd.height}`);
    console.log('Classified layers:', classifiedLayers);

  } catch (err) {
    console.error('Failed to load PSD:', err);
    showToast(`Failed to load PSD: ${err.message}`, 'error');
  }
}

// ============================================
// Layer Classification
// ============================================

// Normalize an option name for matching (strips whitespace, lowercases, removes non-alphanumeric)
function normalizeOptionName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Generate a merge key for a variant group's options (normalized, sorted)
function getOptionMergeKey(group) {
  return group.options.map(o => normalizeOptionName(o.name)).sort().join('\0');
}

// Escape HTML special characters to prevent injection via innerHTML
function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const COLOR_ROLES = {
  red: 'locked',
  blue: 'variant',
  orange: 'info',
  violet: 'toggle',
  fuchsia: 'toggle',
};

function classifyLayers(layers, depth = 0) {
  const result = {
    toggle: [],
    variant: [],
    locked: [],
    info: [],
    regular: [],
  };

  for (const layer of layers) {
    const color = layer.layerColor || 'none';
    const role = COLOR_ROLES[color];
    const name = layer.name || '(unnamed)';
    const isGroup = Array.isArray(layer.children);

    const layerInfo = {
      name,
      color,
      role: role || 'regular',
      isGroup,
      hidden: !!layer.hidden,
      id: generateLayerId(name, depth),
    };

    if (role === 'toggle') {
      result.toggle.push(layerInfo);
    } else if (role === 'variant' && isGroup) {
      const options = (layer.children || []).map((child, i) => ({
        name: child.name || `Option ${i + 1}`,
        id: generateLayerId(child.name || `opt-${i}`, depth + 1),
      }));
      result.variant.push({ ...layerInfo, options });
    } else if (role === 'locked') {
      if (isPaintOverlay(name)) {
        layerInfo.role = 'toggle';
        result.toggle.push(layerInfo);
      } else {
        result.locked.push(layerInfo);
      }
    } else if (role === 'info') {
      // Store child names on groups so we can detect conditional groups at render time
      if (isGroup) {
        layerInfo.childNames = (layer.children || []).map(c => c.name || '');
      }
      result.info.push(layerInfo);
    } else if (isGroup && depth < 2) {
      const childResult = classifyLayers(layer.children, depth + 1);
      result.toggle.push(...childResult.toggle);
      result.variant.push(...childResult.variant);
      result.locked.push(...childResult.locked);
      result.info.push(...childResult.info);
      result.regular.push(...childResult.regular);
    } else {
      result.regular.push(layerInfo);
    }
  }

  return result;
}

function isPaintOverlay(name) {
  return name.toLowerCase().replace(/\s+/g, '').includes('paintoverlay');
}

let idCounter = 0;
// Detect if PSD has multiple departments (uncolored groups containing side-patterned sub-groups)
function detectDepartments(psdChildren) {
  const SIDE_PATTERNS = ['left side', 'right side', 'rear', 'front', 'hood', 'roof'];
  const candidates = [];

  for (const layer of psdChildren) {
    const color = layer.layerColor || 'none';
    const role = COLOR_ROLES[color];
    if (role || !Array.isArray(layer.children)) continue;

    // Check if this uncolored group contains side-patterned sub-groups
    const hasSides = layer.children.some(child =>
      Array.isArray(child.children) &&
      !COLOR_ROLES[child.layerColor || 'none'] &&
      SIDE_PATTERNS.includes(child.name.toLowerCase().trim())
    );

    if (hasSides) {
      candidates.push({ name: layer.name, psdLayer: layer });
    }
  }

  return candidates.length >= 2 ? candidates : null;
}

// Check if we're in multi-department mode
function isMultiDepartment() {
  return departments !== null;
}

// Get the active department object (or null for single-dept)
function getActiveDepartment() {
  if (!departments) return null;
  return departments[selectedDepartmentIndex] || null;
}

// Save current global state back into the active department
function saveDepartmentState() {
  if (!departments) return;
  const dept = departments[selectedDepartmentIndex];
  if (!dept) return;
  dept.classifiedLayers = classifiedLayers;
  dept.variants = variants;
  dept.nextVariantId = nextVariantId;
  dept.selectedVariantId = selectedVariantId;
  dept.templateVariantId = templateVariantId;
}

// Load a department's state into the globals
function loadDepartmentIntoGlobals(index) {
  if (!departments || !departments[index]) return;
  const dept = departments[index];
  classifiedLayers = dept.classifiedLayers;
  variants = dept.variants;
  nextVariantId = dept.nextVariantId;
  selectedVariantId = dept.selectedVariantId;
  templateVariantId = dept.templateVariantId;
  selectedDepartmentIndex = index;
}

// Switch to a different department
function switchDepartment(index) {
  if (!departments || index === selectedDepartmentIndex) return;
  saveDepartmentState();
  loadDepartmentIntoGlobals(index);
  renderDepartmentBar();
  renderVariantList();
  renderLayerSettings();
  updateBottomBar();
  renderPreview();
}

// Get the children to composite for preview/export
// In multi-dept mode: active department's children + shared top-level layers
function getEffectiveChildren(departmentIndex) {
  if (!departments) return currentPsd.children || [];
  const deptNames = new Set(departments.map(d => d.name));
  const dept = departments[departmentIndex];
  const result = [];
  for (const layer of (currentPsd.children || [])) {
    if (layer.name === dept.name) {
      // Include this department's children directly (flatten one level)
      result.push(layer);
    } else if (!deptNames.has(layer.name)) {
      // Include shared layers (not a department)
      result.push(layer);
    }
  }
  return result;
}

function generateLayerId(name, depth) {
  idCounter++;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `layer-${slug}-${idCounter}`;
}

// ============================================
// Required Layer Validation
// ============================================

const REQUIRED_LAYERS = ['AO Map', 'Watermark', 'Template', 'Paint Overlay'];

function validateRequiredLayers(classified) {
  const allNames = [
    ...classified.locked.map(l => l.name),
    ...classified.toggle.map(l => l.name),
    ...classified.variant.map(l => l.name),
    ...classified.info.map(l => l.name),
    ...classified.regular.map(l => l.name),
  ];

  const missing = REQUIRED_LAYERS.filter(req =>
    !allNames.some(name => name.toLowerCase() === req.toLowerCase())
  );

  if (missing.length > 0) {
    showToast(`Missing layers: ${missing.join(', ')}`, 'warning', 5000);
  }
}

// ============================================
// Render Variant List (Left Panel)
// ============================================

function renderDepartmentBar() {
  const bar = document.getElementById('department-bar');
  if (!bar) return;
  if (!departments) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = '';
  bar.innerHTML = '';
  for (let i = 0; i < departments.length; i++) {
    const tab = document.createElement('button');
    tab.className = `department-tab${i === selectedDepartmentIndex ? ' active' : ''}`;
    tab.textContent = departments[i].name;
    tab.addEventListener('click', () => switchDepartment(i));
    bar.appendChild(tab);
  }
}

function renderVariantList() {
  const container = document.getElementById('variant-list');
  const countEl = document.getElementById('variant-count');

  container.innerHTML = '';

  if (variants.length === 0) {
    container.innerHTML = '<div class="variant-list-empty">Load a PSD to get started</div>';
    countEl.style.display = 'none';
    return;
  }

  countEl.textContent = variants.length;
  countEl.style.display = '';

  // Determine which variant is the effective template
  const effectiveTemplateId = templateVariantId != null ? templateVariantId : variants.find(v => v.isBase)?.id;

  for (const variant of variants) {
    const item = document.createElement('div');
    const isActive = variant.id === selectedVariantId;
    const isMultiSelected = selectedVariantIds.has(variant.id);
    item.className = `variant-item${isActive ? ' active' : ''}${isMultiSelected ? ' multi-selected' : ''}`;
    item.dataset.variantId = variant.id;

    const isTemplate = variant.id === effectiveTemplateId;
    const badges = [];
    if (variant.isBase) badges.push('<span class="variant-item-badge">Base</span>');
    if (isTemplate && templateVariantId != null) badges.push('<span class="variant-item-badge template">Template</span>');

    item.innerHTML = `
      <span class="variant-item-indicator"></span>
      <span class="variant-item-name">${escHtml(variant.name)}</span>
      ${badges.join('')}
    `;

    item.addEventListener('mouseenter', () => { hoveredVariantId = variant.id; });
    item.addEventListener('mouseleave', () => { if (hoveredVariantId === variant.id) hoveredVariantId = null; });

    container.appendChild(item);
  }

  // Update delete button state
  const selected = getSelectedVariant();
  document.getElementById('btn-delete-variant').disabled = !selected || selected.isBase;
}

// ============================================
// Render Layer Settings (Right Panel)
// ============================================

const SVG_ICONS = {
  toggle: `<svg class="settings-section-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <rect x="1" y="1" width="14" height="14" rx="2"/><path d="M5 8h6"/>
  </svg>`,
  variant: `<svg class="settings-section-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.5" fill="currentColor"/>
  </svg>`,
  locked: `<svg class="settings-section-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <rect x="3" y="7" width="10" height="8" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/>
  </svg>`,
  info: `<svg class="settings-section-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <circle cx="8" cy="8" r="6"/><path d="M8 5v0M8 7v4"/>
  </svg>`,
  lockSmall: `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <rect x="2" y="5" width="8" height="6" rx="1"/><path d="M4 5V3.5a2 2 0 0 1 4 0V5"/>
  </svg>`,
  infoSmall: `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <circle cx="6" cy="6" r="5"/><path d="M6 3.5v0M6 5v3.5"/>
  </svg>`,
};

function renderLayerSettings() {
  const container = document.getElementById('settings-content');
  container.innerHTML = '';

  if (!classifiedLayers) {
    container.innerHTML = '<div class="settings-empty">No PSD loaded</div>';
    return;
  }

  const variant = getSelectedVariant();
  if (!variant) {
    container.innerHTML = '<div class="settings-empty">No variant selected</div>';
    return;
  }

  let hasContent = false;

  // Toggleable layers (fuchsia/violet)
  const uniqueToggles = getUniqueToggleLayers();
  if (uniqueToggles.length > 0) {
    hasContent = true;
    const section = createSection('Toggleable', SVG_ICONS.toggle);
    for (const layer of uniqueToggles) {
      const state = variant.layerStates[layer.name];
      const isChecked = state ? state.visible : false;
      const row = document.createElement('div');
      row.className = 'setting-row';
      row.innerHTML = `
        <input type="checkbox" id="chk-${variant.id}-${layer.id}" data-layer-name="${escHtml(layer.name)}" ${isChecked ? 'checked' : ''}>
        <label for="chk-${variant.id}-${layer.id}">${escHtml(layer.name)}</label>
      `;

      const checkbox = row.querySelector('input');
      checkbox.addEventListener('change', () => {
        variant.layerStates[layer.name] = { visible: checkbox.checked };
        schedulePreviewUpdate();
        saveSidecar();
      });

      section.appendChild(row);
    }
    container.appendChild(section);
  }

  // Variant groups (blue) — merge groups with identical option sets
  const uniqueGroups = getUniqueVariantGroups();
  if (uniqueGroups.length > 0) {
    hasContent = true;
    const section = createSection('Variants (pick one each)', SVG_ICONS.variant);

    // Group variant groups by their sorted option name set
    const mergedGroups = [];
    const mergedMap = new Map(); // optionKey -> merged entry
    for (const group of uniqueGroups) {
      const optionNames = group.options.map(o => o.name);
      const optionKey = getOptionMergeKey(group);
      if (mergedMap.has(optionKey)) {
        mergedMap.get(optionKey).groupNames.push(group.name);
      } else {
        const entry = { group, groupNames: [group.name], optionNames };
        mergedMap.set(optionKey, entry);
        mergedGroups.push(entry);
      }
    }

    for (const merged of mergedGroups) {
      const { group, groupNames } = merged;
      // Use state from first group name that has a saved state
      let selectedOption = group.options[0]?.name;
      for (const gn of groupNames) {
        const state = variant.layerStates[gn];
        if (state && state.selectedOption) {
          selectedOption = state.selectedOption;
          break;
        }
      }

      const radioGroup = document.createElement('div');
      radioGroup.className = 'radio-group';
      // Show merged label: if multiple groups, join names
      const label = groupNames.length > 1 ? groupNames.join(' / ') : groupNames[0];
      radioGroup.innerHTML = `<div class="radio-group-label">${escHtml(label)}</div>`;

      for (let i = 0; i < group.options.length; i++) {
        const opt = group.options[i];
        const radioName = `radio-${variant.id}-${group.id}`;
        const radioId = `radio-${variant.id}-${opt.id}`;
        const isSelected = opt.name === selectedOption;

        const option = document.createElement('div');
        option.className = 'radio-option';
        option.innerHTML = `
          <input type="radio" name="${radioName}" id="${radioId}" data-group="${escHtml(group.name)}" data-option="${escHtml(opt.name)}" ${isSelected ? 'checked' : ''}>
          <label for="${radioId}">${escHtml(opt.name)}</label>
        `;

        const radio = option.querySelector('input');
        radio.addEventListener('change', () => {
          if (radio.checked) {
            // Update all merged group names to keep them in sync
            for (const gn of groupNames) {
              variant.layerStates[gn] = { selectedOption: opt.name };
            }
            schedulePreviewUpdate();
            saveSidecar();
          }
        });

        radioGroup.appendChild(option);
      }

      section.appendChild(radioGroup);
    }
    container.appendChild(section);
  }

  // Locked layers (red) — deduplicate
  const uniqueLocked = dedupeByName(classifiedLayers.locked);
  if (uniqueLocked.length > 0) {
    hasContent = true;
    const section = createSection('Locked', SVG_ICONS.locked);
    for (const layer of uniqueLocked) {
      const item = document.createElement('div');
      item.className = 'locked-item';
      item.innerHTML = `${SVG_ICONS.lockSmall} ${escHtml(layer.name)}`;
      section.appendChild(item);
    }
    container.appendChild(section);
  }

  // Info layers (orange) — deduplicate, skip conditional groups handled by toggle system
  const toggleNamesNorm = uniqueToggles.map(t => normalizeName(t.name));
  const uniqueInfo = dedupeByName(classifiedLayers.info).filter(layer => {
    if (!layer.childNames) return true; // leaf orange layers always show
    // Skip groups whose children match toggle names (handled automatically)
    return !layer.childNames.some(cn => toggleNamesNorm.includes(normalizeName(cn)));
  });
  if (uniqueInfo.length > 0) {
    hasContent = true;
    const section = createSection('Requires Editing', SVG_ICONS.info);
    for (const layer of uniqueInfo) {
      const item = document.createElement('div');
      item.className = 'info-item';
      item.innerHTML = `${SVG_ICONS.infoSmall} ${escHtml(layer.name)}`;
      section.appendChild(item);
    }
    container.appendChild(section);
  }

  if (!hasContent) {
    container.innerHTML = '<div class="settings-empty">No color-coded layers found in this PSD</div>';
  }
}

function dedupeByName(layers) {
  const seen = new Set();
  return layers.filter(l => {
    const key = l.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createSection(title, iconSvg) {
  const section = document.createElement('div');
  section.className = 'settings-section';
  section.innerHTML = `
    <div class="settings-section-header">
      ${iconSvg}
      <span class="settings-section-title">${title}</span>
    </div>
  `;
  return section;
}

// ============================================
// Live Preview & Compositing
// ============================================

const BLEND_MODE_MAP = {
  'normal': 'source-over',
  'dissolve': 'source-over',
  'darken': 'darken',
  'multiply': 'multiply',
  'color burn': 'color-burn',
  'linear burn': 'source-over',
  'darker color': 'darken',
  'lighten': 'lighten',
  'screen': 'screen',
  'color dodge': 'color-dodge',
  'linear dodge': 'source-over',
  'lighter color': 'lighten',
  'overlay': 'overlay',
  'soft light': 'soft-light',
  'hard light': 'hard-light',
  'vivid light': 'source-over',
  'linear light': 'source-over',
  'pin light': 'source-over',
  'hard mix': 'source-over',
  'difference': 'difference',
  'exclusion': 'exclusion',
  'subtract': 'source-over',
  'divide': 'source-over',
  'hue': 'hue',
  'saturation': 'saturation',
  'color': 'color',
  'luminosity': 'luminosity',
  'pass through': 'source-over',
};

function mapBlendMode(mode) {
  return BLEND_MODE_MAP[mode] || 'source-over';
}

function isLayerVisibleForComposite(layer, layerStates, parentVariantGroupName, insideSelectedOption, insideToggleGroup) {
  const color = layer.layerColor || 'none';
  const role = COLOR_ROLES[color];
  const name = layer.name || '(unnamed)';

  // Red (locked): always visible, except Paint Overlay which is toggleable
  if (role === 'locked') {
    if (isPaintOverlay(name)) {
      const state = layerStates[name];
      return state ? state.visible : true;
    }
    return true;
  }

  // Toggle (fuchsia/violet): check variant state OR parent toggle group controls it
  if (role === 'toggle') {
    if (insideToggleGroup) {
      // Inside a visible parent toggle group — treat as regular layer, respect hidden flag
      return !layer.hidden;
    }
    const state = layerStates[name];
    return state ? state.visible : false;
  }

  // Child of a blue variant group: only visible if it's the selected option
  if (parentVariantGroupName) {
    const state = layerStates[parentVariantGroupName];
    return state ? state.selectedOption === name : false;
  }

  // Blue variant group itself: visible (children handle their own visibility)
  if (role === 'variant' && Array.isArray(layer.children)) return true;

  // Inside a selected variant option: respect PSD hidden flag
  // (artist sets hidden on flipped/wrong-orientation layers intentionally)
  if (insideSelectedOption) return !layer.hidden;

  // Regular, orange, info, uncolored groups: respect PSD hidden flag
  if (layer.hidden) return false;

  return true;
}

// Convert ag-psd grayscale mask (R=G=B=value, A=255) to alpha mask (R=G=B=255, A=value)
// ag-psd stores masks as grayscale canvases where the RGB channels hold the mask value
// but alpha is always 255. Canvas 'destination-in' only checks alpha, so we must convert.
function createAlphaMask(mask, layerWidth, layerHeight, layerLeft, layerTop) {
  const canvas = document.createElement('canvas');
  canvas.width = layerWidth;
  canvas.height = layerHeight;
  const ctx = canvas.getContext('2d');

  // Fill with default color (areas outside mask canvas)
  // defaultColor=255 means areas outside mask are visible (white)
  // defaultColor=0 means areas outside mask are hidden (black/transparent)
  if ((mask.defaultColor || 0) === 255) {
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Draw mask canvas at its position relative to the layer
  const mx = (mask.left || 0) - layerLeft;
  const my = (mask.top || 0) - layerTop;
  ctx.drawImage(mask.canvas, mx, my);

  // Convert: grayscale luminance → alpha channel
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i + 3] = data[i]; // Alpha = R (grayscale luminance)
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
  }
  ctx.putImageData(imageData, 0, 0);

  return canvas;
}

// Convert an ag-psd Color object to a CSS rgba() string
function colorToCSS(color, opacity) {
  if (!color) return 'rgba(0,0,0,' + (opacity != null ? opacity : 1) + ')';
  const r = Math.round(color.r || 0);
  const g = Math.round(color.g || 0);
  const b = Math.round(color.b || 0);
  const a = opacity != null ? opacity : 1;
  return `rgba(${r},${g},${b},${a})`;
}

// Get the alpha silhouette of a canvas (white where opaque, transparent where transparent)
function getAlphaSilhouette(sourceCanvas) {
  const c = document.createElement('canvas');
  c.width = sourceCanvas.width;
  c.height = sourceCanvas.height;
  const cx = c.getContext('2d');
  cx.drawImage(sourceCanvas, 0, 0);
  const imgData = cx.getImageData(0, 0, c.width, c.height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    // Keep alpha, set RGB to white (for color fill) or leave for shape
    d[i] = 255;
    d[i + 1] = 255;
    d[i + 2] = 255;
  }
  cx.putImageData(imgData, 0, 0);
  return c;
}

// Apply color overlay (solidFill) effect to a layer canvas
function applyColorOverlay(ctx, layer, contentCanvas, offsetX, offsetY) {
  const effects = layer.effects;
  if (!effects || !effects.solidFill) return;
  for (const fill of effects.solidFill) {
    if (fill.enabled === false) continue;
    const fillOpacity = fill.opacity != null ? fill.opacity : 1;
    const fillBlend = mapBlendMode(fill.blendMode);
    // Create a solid-color canvas clipped to the layer's alpha
    const temp = document.createElement('canvas');
    temp.width = contentCanvas.width;
    temp.height = contentCanvas.height;
    const tCtx = temp.getContext('2d');
    // Fill with the overlay color
    tCtx.fillStyle = colorToCSS(fill.color, 1);
    tCtx.fillRect(0, 0, temp.width, temp.height);
    // Clip to layer alpha using destination-in
    tCtx.globalCompositeOperation = 'destination-in';
    tCtx.drawImage(contentCanvas, 0, 0);
    // Draw onto main context
    ctx.save();
    ctx.globalAlpha = fillOpacity;
    ctx.globalCompositeOperation = fillBlend;
    ctx.drawImage(temp, offsetX, offsetY);
    ctx.restore();
  }
}

// Apply stroke effect to a layer canvas
function applyStroke(ctx, layer, contentCanvas, offsetX, offsetY) {
  const effects = layer.effects;
  if (!effects || !effects.stroke) return;

  for (const stroke of effects.stroke) {
    if (stroke.enabled === false || stroke.present === false) continue;
    if (stroke.fillType && stroke.fillType !== 'color') continue;
    const size = stroke.size ? (stroke.size.value || 0) : 0;
    if (size <= 0) continue;
    const strokeOpacity = stroke.opacity != null ? stroke.opacity : 1;
    const strokeBlend = mapBlendMode(stroke.blendMode);
    const position = stroke.position || 'outside';

    // Crop content canvas to its bounding box to avoid huge padded canvases
    // (important for group layers where contentCanvas = full PSD size)
    const srcCtx = contentCanvas.getContext('2d');
    const srcData = srcCtx.getImageData(0, 0, contentCanvas.width, contentCanvas.height);
    let minX = contentCanvas.width, minY = contentCanvas.height, maxX = 0, maxY = 0;
    const d = srcData.data;
    for (let y = 0; y < contentCanvas.height; y++) {
      for (let x = 0; x < contentCanvas.width; x++) {
        if (d[(y * contentCanvas.width + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX) continue; // fully transparent, skip

    // Extract cropped content
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;
    const cropped = document.createElement('canvas');
    cropped.width = cropW;
    cropped.height = cropH;
    cropped.getContext('2d').drawImage(contentCanvas, -minX, -minY);

    const pad = Math.ceil(size) * 2;
    const temp = document.createElement('canvas');
    temp.width = cropW + pad * 2;
    temp.height = cropH + pad * 2;
    const tCtx = temp.getContext('2d');

    if (position === 'outside' || position === 'center') {
      const radius = position === 'center' ? size / 2 : size;
      const steps = Math.max(1, Math.ceil(radius * 2));
      tCtx.fillStyle = colorToCSS(stroke.color, 1);
      tCtx.fillRect(0, 0, temp.width, temp.height);
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = temp.width;
      maskCanvas.height = temp.height;
      const maskCtx = maskCanvas.getContext('2d');
      for (let angle = 0; angle < 360; angle += Math.max(1, 360 / (steps * 4))) {
        const rad = angle * Math.PI / 180;
        const dx = Math.cos(rad) * radius;
        const dy = Math.sin(rad) * radius;
        maskCtx.drawImage(cropped, pad + dx, pad + dy);
      }
      maskCtx.drawImage(cropped, pad, pad);
      if (position === 'outside') {
        maskCtx.globalCompositeOperation = 'destination-out';
        maskCtx.drawImage(cropped, pad, pad);
      }
      tCtx.globalCompositeOperation = 'destination-in';
      tCtx.drawImage(maskCanvas, 0, 0);
    } else if (position === 'inside') {
      tCtx.fillStyle = colorToCSS(stroke.color, 1);
      tCtx.fillRect(0, 0, temp.width, temp.height);
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = temp.width;
      maskCanvas.height = temp.height;
      const maskCtx = maskCanvas.getContext('2d');
      maskCtx.drawImage(cropped, pad, pad);
      const erodeCanvas = document.createElement('canvas');
      erodeCanvas.width = temp.width;
      erodeCanvas.height = temp.height;
      const erodeCtx = erodeCanvas.getContext('2d');
      erodeCtx.drawImage(cropped, pad, pad);
      const steps = Math.max(1, Math.ceil(size * 2));
      for (let angle = 0; angle < 360; angle += Math.max(1, 360 / (steps * 4))) {
        const rad = angle * Math.PI / 180;
        const dx = Math.cos(rad) * size;
        const dy = Math.sin(rad) * size;
        erodeCtx.globalCompositeOperation = 'destination-in';
        const shifted = document.createElement('canvas');
        shifted.width = temp.width;
        shifted.height = temp.height;
        shifted.getContext('2d').drawImage(cropped, pad + dx, pad + dy);
        erodeCtx.drawImage(shifted, 0, 0);
      }
      maskCtx.globalCompositeOperation = 'destination-out';
      maskCtx.drawImage(erodeCanvas, 0, 0);
      tCtx.globalCompositeOperation = 'destination-in';
      tCtx.drawImage(maskCanvas, 0, 0);
    }

    ctx.save();
    ctx.globalAlpha = strokeOpacity;
    ctx.globalCompositeOperation = strokeBlend;
    ctx.drawImage(temp, offsetX + minX - pad, offsetY + minY - pad);
    ctx.restore();
  }
}

// Apply drop shadow effect
function applyDropShadow(ctx, layer, contentCanvas, offsetX, offsetY) {
  const effects = layer.effects;
  if (!effects || !effects.dropShadow) return;
  for (const shadow of effects.dropShadow) {
    if (shadow.enabled === false) continue;
    const shadowOpacity = shadow.opacity != null ? shadow.opacity : 0.75;
    const shadowBlend = mapBlendMode(shadow.blendMode);
    const angle = (shadow.angle != null ? shadow.angle : 120) * Math.PI / 180;
    const dist = shadow.distance ? (shadow.distance.value || 0) : 0;
    const blur = shadow.size ? (shadow.size.value || 0) : 0;
    const dx = Math.round(Math.cos(angle) * dist);
    const dy = -Math.round(Math.sin(angle) * dist);

    // Create shadow: color-filled silhouette of the layer
    const pad = Math.ceil(blur * 2);
    const temp = document.createElement('canvas');
    temp.width = contentCanvas.width + pad * 2;
    temp.height = contentCanvas.height + pad * 2;
    const tCtx = temp.getContext('2d');
    tCtx.fillStyle = colorToCSS(shadow.color, 1);
    tCtx.fillRect(0, 0, temp.width, temp.height);
    // Clip to layer alpha
    tCtx.globalCompositeOperation = 'destination-in';
    tCtx.drawImage(contentCanvas, pad, pad);
    // Apply blur via CSS filter
    if (blur > 0) {
      const blurTemp = document.createElement('canvas');
      blurTemp.width = temp.width;
      blurTemp.height = temp.height;
      const btCtx = blurTemp.getContext('2d');
      btCtx.filter = `blur(${blur}px)`;
      btCtx.drawImage(temp, 0, 0);
      ctx.save();
      ctx.globalAlpha = shadowOpacity;
      ctx.globalCompositeOperation = shadowBlend;
      ctx.drawImage(blurTemp, offsetX - pad + dx, offsetY - pad + dy);
      ctx.restore();
    } else {
      ctx.save();
      ctx.globalAlpha = shadowOpacity;
      ctx.globalCompositeOperation = shadowBlend;
      ctx.drawImage(temp, offsetX - pad + dx, offsetY - pad + dy);
      ctx.restore();
    }
  }
}

// Apply inner shadow effect
function applyInnerShadow(ctx, layer, contentCanvas, offsetX, offsetY) {
  const effects = layer.effects;
  if (!effects || !effects.innerShadow) return;
  for (const shadow of effects.innerShadow) {
    if (shadow.enabled === false) continue;
    const shadowOpacity = shadow.opacity != null ? shadow.opacity : 0.75;
    const shadowBlend = mapBlendMode(shadow.blendMode);
    const angle = (shadow.angle != null ? shadow.angle : 120) * Math.PI / 180;
    const dist = shadow.distance ? (shadow.distance.value || 0) : 0;
    const blur = shadow.size ? (shadow.size.value || 0) : 0;
    const dx = Math.round(Math.cos(angle) * dist);
    const dy = -Math.round(Math.sin(angle) * dist);

    const pad = Math.ceil(blur * 2);
    const temp = document.createElement('canvas');
    temp.width = contentCanvas.width + pad * 2;
    temp.height = contentCanvas.height + pad * 2;
    const tCtx = temp.getContext('2d');

    // Create inverted alpha (shadow cast from edges inward)
    // Fill with shadow color
    tCtx.fillStyle = colorToCSS(shadow.color, 1);
    tCtx.fillRect(0, 0, temp.width, temp.height);
    // Cut out the layer shape offset by shadow distance (creates shadow on inner edges)
    tCtx.globalCompositeOperation = 'destination-out';
    tCtx.drawImage(contentCanvas, pad + dx, pad + dy);

    // Blur the shadow
    let shadowCanvas = temp;
    if (blur > 0) {
      const blurTemp = document.createElement('canvas');
      blurTemp.width = temp.width;
      blurTemp.height = temp.height;
      const btCtx = blurTemp.getContext('2d');
      btCtx.filter = `blur(${blur}px)`;
      btCtx.drawImage(temp, 0, 0);
      shadowCanvas = blurTemp;
    }

    // Clip to original layer shape
    const clipped = document.createElement('canvas');
    clipped.width = temp.width;
    clipped.height = temp.height;
    const cCtx = clipped.getContext('2d');
    cCtx.drawImage(shadowCanvas, 0, 0);
    cCtx.globalCompositeOperation = 'destination-in';
    cCtx.drawImage(contentCanvas, pad, pad);

    ctx.save();
    ctx.globalAlpha = shadowOpacity;
    ctx.globalCompositeOperation = shadowBlend;
    ctx.drawImage(clipped, offsetX - pad, offsetY - pad);
    ctx.restore();
  }
}

// Check if a layer has any effects that need rendering
function hasEffects(layer) {
  const fx = layer.effects;
  if (!fx || fx.disabled) return false;
  return (fx.solidFill && fx.solidFill.some(f => f.enabled !== false)) ||
    (fx.stroke && fx.stroke.some(s => s.enabled !== false)) ||
    (fx.dropShadow && fx.dropShadow.some(s => s.enabled !== false)) ||
    (fx.innerShadow && fx.innerShadow.some(s => s.enabled !== false));
}

// Draw a single leaf layer (with mask support and effects) onto a target context
function drawLeafLayer(ctx, layer) {
  const alpha = typeof layer.opacity === 'number'
    ? (layer.opacity > 1 ? layer.opacity / 255 : layer.opacity)
    : 1;
  const blendMode = mapBlendMode(layer.blendMode);
  const hasMask = layer.mask && layer.mask.canvas && !layer.mask.disabled;
  const hasFx = hasEffects(layer);

  try {
    // Get the content canvas (with mask applied if needed)
    let contentCanvas = layer.canvas;
    if (hasMask) {
      const temp = document.createElement('canvas');
      temp.width = layer.canvas.width;
      temp.height = layer.canvas.height;
      const tempCtx = temp.getContext('2d');
      tempCtx.drawImage(layer.canvas, 0, 0);
      const alphaMask = createAlphaMask(layer.mask, layer.canvas.width, layer.canvas.height, layer.left || 0, layer.top || 0);
      tempCtx.globalCompositeOperation = 'destination-in';
      tempCtx.drawImage(alphaMask, 0, 0);
      contentCanvas = temp;
    }

    if (hasFx) {
      // Render layer + effects to a PSD-sized temp canvas, then composite once
      const fxTemp = document.createElement('canvas');
      fxTemp.width = ctx.canvas.width;
      fxTemp.height = ctx.canvas.height;
      const fxCtx = fxTemp.getContext('2d');
      const ox = layer.left || 0;
      const oy = layer.top || 0;

      // Drop shadow renders BEHIND the layer
      applyDropShadow(fxCtx, layer, contentCanvas, ox, oy);

      // Draw the layer content
      fxCtx.drawImage(contentCanvas, ox, oy);

      // Color overlay renders ON TOP of the layer content
      applyColorOverlay(fxCtx, layer, contentCanvas, ox, oy);

      // Inner shadow renders inside the layer
      applyInnerShadow(fxCtx, layer, contentCanvas, ox, oy);

      // Stroke renders around the layer
      applyStroke(fxCtx, layer, contentCanvas, ox, oy);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = blendMode;
      ctx.drawImage(fxTemp, 0, 0);
      ctx.restore();
    } else {
      // No effects — original fast path
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = blendMode;
      ctx.drawImage(contentCanvas, layer.left || 0, layer.top || 0);
      ctx.restore();
    }
  } catch (err) {
    console.warn(`Failed to draw layer "${layer.name}":`, err);
  }
}

// Process a list of children, grouping clipping layers with their base
function drawChildren(ctx, children, layerStates, parentVariantGroupName, insideSelectedOption, insideToggleGroup) {
  let i = 0;
  while (i < children.length) {
    const baseLayer = children[i];

    // Collect subsequent clipping layers
    const clippedLayers = [];
    let j = i + 1;
    while (j < children.length && children[j].clipping) {
      clippedLayers.push(children[j]);
      j++;
    }

    if (clippedLayers.length > 0) {
      drawClippingGroup(ctx, baseLayer, clippedLayers, layerStates, parentVariantGroupName, insideSelectedOption, insideToggleGroup);
    } else {
      drawLayerToCanvas(ctx, baseLayer, layerStates, parentVariantGroupName, insideSelectedOption, insideToggleGroup);
    }

    i = j;
  }
}

// Draw a base layer + its clipping layers as a group
function drawClippingGroup(ctx, baseLayer, clippedLayers, layerStates, parentVariantGroupName, insideSelectedOption, insideToggleGroup) {
  if (!isLayerVisibleForComposite(baseLayer, layerStates, parentVariantGroupName, insideSelectedOption, insideToggleGroup)) return;

  const isGroup = Array.isArray(baseLayer.children);

  // Create temp canvas at PSD size for the clipping group
  const temp = document.createElement('canvas');
  temp.width = ctx.canvas.width;
  temp.height = ctx.canvas.height;
  const tempCtx = temp.getContext('2d');

  // Draw the base layer onto temp
  if (isGroup) {
    const color = baseLayer.layerColor || 'none';
    const role = COLOR_ROLES[color];
    const isVariantGroup = role === 'variant' && !parentVariantGroupName && !insideSelectedOption;
    const isToggleGroup = role === 'toggle';
    const childGroupName = isVariantGroup ? baseLayer.name : null;
    const childInsideOption = insideSelectedOption || (parentVariantGroupName != null);
    const childInsideToggle = insideToggleGroup || isToggleGroup;
    drawChildren(tempCtx, baseLayer.children, layerStates, childGroupName, childInsideOption, childInsideToggle);
  } else if (baseLayer.canvas) {
    drawLeafLayer(tempCtx, baseLayer);
  }

  // Draw each visible clipping layer using source-atop (clips to base content)
  for (const clipped of clippedLayers) {
    if (!isLayerVisibleForComposite(clipped, layerStates, parentVariantGroupName, insideSelectedOption, insideToggleGroup)) continue;

    const clippedIsGroup = Array.isArray(clipped.children);
    if (clippedIsGroup) {
      // Clipped group: render its children to another temp, then source-atop
      const groupTemp = document.createElement('canvas');
      groupTemp.width = ctx.canvas.width;
      groupTemp.height = ctx.canvas.height;
      const groupCtx = groupTemp.getContext('2d');
      const color = clipped.layerColor || 'none';
      const role = COLOR_ROLES[color];
      const isVariantGroup = role === 'variant' && !parentVariantGroupName && !insideSelectedOption;
      const isToggleGroup2 = role === 'toggle';
      const childGroupName = isVariantGroup ? clipped.name : null;
      const childInsideOption = insideSelectedOption || (parentVariantGroupName != null);
      const childInsideToggle = insideToggleGroup || isToggleGroup2;
      drawChildren(groupCtx, clipped.children, layerStates, childGroupName, childInsideOption, childInsideToggle);

      tempCtx.save();
      tempCtx.globalCompositeOperation = 'source-atop';
      const a = typeof clipped.opacity === 'number'
        ? (clipped.opacity > 1 ? clipped.opacity / 255 : clipped.opacity) : 1;
      tempCtx.globalAlpha = a;
      tempCtx.drawImage(groupTemp, 0, 0);
      tempCtx.restore();
    } else if (clipped.canvas) {
      tempCtx.save();
      tempCtx.globalCompositeOperation = 'source-atop';
      const a = typeof clipped.opacity === 'number'
        ? (clipped.opacity > 1 ? clipped.opacity / 255 : clipped.opacity) : 1;
      tempCtx.globalAlpha = a;

      // Handle mask on clipped layer
      if (clipped.mask && clipped.mask.canvas && !clipped.mask.disabled) {
        const maskTemp = document.createElement('canvas');
        maskTemp.width = clipped.canvas.width;
        maskTemp.height = clipped.canvas.height;
        const maskCtx = maskTemp.getContext('2d');
        maskCtx.drawImage(clipped.canvas, 0, 0);
        const alphaMask = createAlphaMask(clipped.mask, clipped.canvas.width, clipped.canvas.height, clipped.left || 0, clipped.top || 0);
        maskCtx.globalCompositeOperation = 'destination-in';
        maskCtx.drawImage(alphaMask, 0, 0);
        tempCtx.drawImage(maskTemp, clipped.left || 0, clipped.top || 0);
      } else {
        tempCtx.drawImage(clipped.canvas, clipped.left || 0, clipped.top || 0);
      }
      tempCtx.restore();
    }
  }

  // Apply effects from the base layer to the composited clipping group
  const baseAlpha = typeof baseLayer.opacity === 'number'
    ? (baseLayer.opacity > 1 ? baseLayer.opacity / 255 : baseLayer.opacity) : 1;
  const baseHasFx = hasEffects(baseLayer);

  if (baseHasFx) {
    applyDropShadow(ctx, baseLayer, temp, 0, 0);
    ctx.save();
    ctx.globalAlpha = baseAlpha;
    ctx.globalCompositeOperation = mapBlendMode(baseLayer.blendMode);
    ctx.drawImage(temp, 0, 0);
    ctx.restore();
    applyColorOverlay(ctx, baseLayer, temp, 0, 0);
    applyInnerShadow(ctx, baseLayer, temp, 0, 0);
    applyStroke(ctx, baseLayer, temp, 0, 0);
  } else {
    ctx.save();
    ctx.globalAlpha = baseAlpha;
    ctx.globalCompositeOperation = mapBlendMode(baseLayer.blendMode);
    ctx.drawImage(temp, 0, 0);
    ctx.restore();
  }
}

// Normalize a layer name for fuzzy matching (strips non-alphanumeric, lowercases)
// Handles "Caution K9" vs "Caution K-9" etc.
function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Find a toggle state key that matches a child name (fuzzy, normalized)
function findToggleMatch(childName, layerStates) {
  const normalized = normalizeName(childName);
  if (!normalized) return null;
  return Object.keys(layerStates).find(
    k => normalizeName(k) === normalized && 'visible' in layerStates[k]
  );
}

// Check if an orange (info) group has children whose names match toggle states
function isConditionalInfoGroup(children, layerStates) {
  if (children.length < 2) return false;
  return children.some(c => findToggleMatch(c.name, layerStates));
}

// Draw the correct child of a conditional orange group based on active toggles.
// Children matching an active toggle are shown; otherwise, non-matching children (defaults) are shown.
// Works for both sub-group children and leaf children.
function drawConditionalInfoGroup(ctx, group, layerStates) {
  const children = group.children || [];

  // Find which child should be active (matching an ON toggle)
  let activeChild = null;
  for (const child of children) {
    const matchKey = findToggleMatch(child.name, layerStates);
    if (matchKey && layerStates[matchKey].visible) {
      activeChild = child;
      break;
    }
  }

  if (activeChild) {
    // Toggle is ON — draw only the matched child (ignore hidden flag)
    if (Array.isArray(activeChild.children)) {
      drawChildren(ctx, activeChild.children, layerStates, null, false, false);
    } else if (activeChild.canvas) {
      drawLeafLayer(ctx, activeChild);
    }
  } else {
    // No toggle active — draw the default children (those that DON'T match any toggle)
    for (const child of children) {
      if (findToggleMatch(child.name, layerStates)) continue;

      if (Array.isArray(child.children)) {
        drawChildren(ctx, child.children, layerStates, null, false, false);
      } else if (child.canvas && !child.hidden) {
        drawLeafLayer(ctx, child);
      }
    }
  }
}

function drawLayerToCanvas(ctx, layer, layerStates, parentVariantGroupName, insideSelectedOption, insideToggleGroup) {
  if (!isLayerVisibleForComposite(layer, layerStates, parentVariantGroupName, insideSelectedOption, insideToggleGroup)) return;

  const isGroup = Array.isArray(layer.children);

  if (isGroup) {
    const color = layer.layerColor || 'none';
    const role = COLOR_ROLES[color];

    // Conditional orange group: swap children based on active toggles
    if (role === 'info' && isConditionalInfoGroup(layer.children, layerStates)) {
      drawConditionalInfoGroup(ctx, layer, layerStates);
      return;
    }

    // Only treat as variant group if not already inside a variant scope
    // (variant options that are blue groups shouldn't create nested scopes)
    const isVariantGroup = role === 'variant' && !parentVariantGroupName && !insideSelectedOption;
    const isToggleGroup = role === 'toggle';
    const childGroupName = isVariantGroup ? layer.name : null;
    const childInsideOption = insideSelectedOption || (parentVariantGroupName != null);
    const childInsideToggle = insideToggleGroup || isToggleGroup;

    const groupOpacity = typeof layer.opacity === 'number'
      ? (layer.opacity > 1 ? layer.opacity / 255 : layer.opacity) : 1;
    const isPassThrough = (layer.blendMode === 'pass through');
    const groupHasFx = hasEffects(layer);
    const needsIsolation = groupOpacity < 1 || !isPassThrough || groupHasFx;

    if (needsIsolation) {
      // Render children to temp canvas, then composite with group opacity/blend
      const temp = document.createElement('canvas');
      temp.width = ctx.canvas.width;
      temp.height = ctx.canvas.height;
      const tempCtx = temp.getContext('2d');
      drawChildren(tempCtx, layer.children, layerStates, childGroupName, childInsideOption, childInsideToggle);

      if (groupHasFx) {
        // Apply effects to the composited group content
        // We need to treat the group's composited result as the "content canvas"
        applyDropShadow(ctx, layer, temp, 0, 0);
        // Draw the group content first
        ctx.save();
        ctx.globalAlpha = groupOpacity;
        ctx.globalCompositeOperation = isPassThrough ? 'source-over' : mapBlendMode(layer.blendMode);
        ctx.drawImage(temp, 0, 0);
        ctx.restore();
        // Apply overlay effects on top
        applyColorOverlay(ctx, layer, temp, 0, 0);
        applyInnerShadow(ctx, layer, temp, 0, 0);
        applyStroke(ctx, layer, temp, 0, 0);
      } else {
        ctx.save();
        ctx.globalAlpha = groupOpacity;
        ctx.globalCompositeOperation = isPassThrough ? 'source-over' : mapBlendMode(layer.blendMode);
        ctx.drawImage(temp, 0, 0);
        ctx.restore();
      }
    } else {
      drawChildren(ctx, layer.children, layerStates, childGroupName, childInsideOption, childInsideToggle);
    }
  } else if (layer.canvas) {
    drawLeafLayer(ctx, layer);
  }
}

function drawCheckerboard(ctx, width, height) {
  const size = 16;
  for (let y = 0; y < height; y += size) {
    for (let x = 0; x < width; x += size) {
      ctx.fillStyle = ((x / size + y / size) % 2 === 0) ? '#3a3a3a' : '#2e2e2e';
      ctx.fillRect(x, y, size, size);
    }
  }
}

function renderPreview() {
  if (!currentPsd) return;

  const variant = getSelectedVariant();
  if (!variant) return;

  // Log layer tree on first render (F12 to see console)
  if (!currentPsd._logged) {
    currentPsd._logged = true;
    console.log('=== PSD Layer Tree ===');
    (function logTree(layers, indent) {
      for (const l of layers) {
        const maskInfo = l.mask ? `mask=${!l.mask.disabled}(default=${l.mask.defaultColor})` : 'mask=none';
        const clipInfo = l.clipping ? 'CLIPPING' : '';
        console.log(`${indent}${l.name} | color=${l.layerColor || 'none'} | canvas=${!!l.canvas} | blend=${l.blendMode} | opacity=${l.opacity} | hidden=${!!l.hidden} | ${maskInfo} ${clipInfo} | children=${l.children ? l.children.length : 0} | fx=${hasEffects(l)}`);
        if (l.children) logTree(l.children, indent + '  ');
      }
    })(currentPsd.children || [], '');
    console.log('=== Variant State ===', JSON.stringify(variant.layerStates, null, 2));
  }

  const canvas = document.getElementById('preview-canvas');
  canvas.width = currentPsd.width;
  canvas.height = currentPsd.height;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const startTime = performance.now();

  // Draw checkerboard background (transparency indicator)
  drawCheckerboard(ctx, canvas.width, canvas.height);

  // Composite layers bottom-to-top with clipping group support
  drawChildren(ctx, getEffectiveChildren(selectedDepartmentIndex), variant.layerStates, null, false, false);

  const elapsed = performance.now() - startTime;
  const info = document.getElementById('preview-info');
  info.textContent = `${currentPsd.width}x${currentPsd.height} \u2022 ${Math.round(elapsed)}ms`;

  if (elapsed > 2000) {
    showToast(`Preview render took ${(elapsed / 1000).toFixed(1)}s`, 'warning');
  }
}

let previewDebounceTimer = null;
let pendingPreviewUpdate = false;

function schedulePreviewUpdate() {
  if (document.hidden) {
    pendingPreviewUpdate = true;
    return;
  }
  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(renderPreview, 50);
}

// Re-render when window becomes visible again if an update was pending
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && pendingPreviewUpdate) {
    pendingPreviewUpdate = false;
    schedulePreviewUpdate();
  }
});

// ============================================
// Variant Actions
// ============================================

function selectVariant(id) {
  selectedVariantId = id;
  renderVariantList();
  renderLayerSettings();
  updateBottomBar();
  renderPreview();
}

function addVariant() {
  const variant = createNewVariant(`Variant ${variants.length}`);
  if (!variant) return;

  variants.push(variant);
  selectedVariantId = variant.id;

  renderVariantList();
  renderLayerSettings();
  updateBottomBar();
  renderPreview();
  saveSidecar();

  // Focus the name input so user can rename immediately
  const nameInput = document.getElementById('variant-name');
  nameInput.disabled = false;
  nameInput.select();
  nameInput.focus();
}

function deleteSelectedVariant() {
  const variant = getSelectedVariant();
  if (!variant || variant.isBase) return;

  const idx = variants.indexOf(variant);
  variants.splice(idx, 1);

  // Select the previous variant, or Base
  if (variants.length > 0) {
    const newIdx = Math.min(idx, variants.length - 1);
    selectedVariantId = variants[newIdx].id;
  }

  renderVariantList();
  renderLayerSettings();
  updateBottomBar();
  saveSidecar();

  showToast(`Deleted "${variant.name}"`, 'success');
}

// ============================================
// Bottom Bar
// ============================================

function updateBottomBar() {
  const nameInput = document.getElementById('variant-name');
  const variant = getSelectedVariant();

  if (variant) {
    nameInput.disabled = false;
    nameInput.value = variant.name;
  } else {
    nameInput.disabled = true;
    nameInput.value = '';
  }
}

// ============================================
// Duplicate Variant Name Warning
// ============================================

function checkDuplicateVariantName(name, variantId) {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return;
  const duplicate = variants.find(v => v.id !== variantId && v.name.trim().toLowerCase() === normalized);
  if (duplicate) {
    showToast(`Duplicate variant name: "${name}"`, 'warning');
  }
}

// ============================================
// Open PSD Dialog Helper
// ============================================

async function openPsdDialog() {
  const filePath = await ipcRenderer.invoke('open-psd-dialog');
  if (filePath) loadPsdFile(filePath);
}

// ============================================
// Inline Variant Rename
// ============================================

function startInlineRename(variant, nameSpan) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'variant-item-rename';
  input.value = variant.name;

  nameSpan.replaceWith(input);
  input.select();
  input.focus();

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    const newName = input.value.trim() || variant.name;
    variant.name = newName;
    checkDuplicateVariantName(newName, variant.id);
    renderVariantList();
    updateBottomBar();
    saveSidecar();
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { input.blur(); }
    if (e.key === 'Escape') {
      input.value = variant.name;
      input.blur();
    }
    e.stopPropagation();
  });
  input.addEventListener('click', (e) => e.stopPropagation());
}

// ============================================
// Preview Resize & Fullscreen
// ============================================

const previewContainer = document.getElementById('preview-container');

// Variants panel resize
const variantsPanel = document.getElementById('panel-variants');
const variantsResizeHandle = document.getElementById('variants-resize-handle');
let isResizingVariants = false;
let variantsResizeStartX, variantsResizeStartWidth;

variantsResizeHandle.addEventListener('mousedown', (e) => {
  isResizingVariants = true;
  variantsResizeStartX = e.clientX;
  variantsResizeStartWidth = variantsPanel.offsetWidth;
  variantsResizeHandle.classList.add('active');
  document.body.style.cursor = 'col-resize';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isResizingVariants) return;
  if (!e.timeStamp || e.timeStamp - (variantsResizeHandle._lastMove || 0) < 16) return;
  variantsResizeHandle._lastMove = e.timeStamp;
  const delta = e.clientX - variantsResizeStartX;
  const newWidth = Math.max(140, Math.min(500, variantsResizeStartWidth + delta));
  variantsPanel.style.width = newWidth + 'px';
});

document.addEventListener('mouseup', () => {
  if (isResizingVariants) {
    isResizingVariants = false;
    variantsResizeHandle.classList.remove('active');
    document.body.style.cursor = '';
  }
});

// Fullscreen preview
document.getElementById('btn-preview-expand').addEventListener('click', () => {
  const overlay = document.getElementById('preview-overlay');
  const overlayCanvas = document.getElementById('preview-overlay-canvas');
  const srcCanvas = document.getElementById('preview-canvas');

  overlayCanvas.width = srcCanvas.width;
  overlayCanvas.height = srcCanvas.height;
  overlayCanvas.getContext('2d').drawImage(srcCanvas, 0, 0);

  overlay.style.display = '';
});

document.getElementById('preview-overlay').addEventListener('click', () => {
  document.getElementById('preview-overlay').style.display = 'none';
});

// ============================================
// Help Modal
// ============================================

function initHelpModal() {
  const overlay = document.getElementById('help-modal-overlay');
  const closeBtn = document.getElementById('help-modal-close');
  const navItems = document.querySelectorAll('.help-nav-item');
  const content = document.querySelector('.help-modal-content');

  if (!overlay) return;

  closeBtn.addEventListener('click', closeHelpModal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeHelpModal();
  });

  // Navigation clicks
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const targetId = item.getAttribute('href').substring(1);
      const targetSection = document.getElementById(targetId);
      if (targetSection && content) {
        targetSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        navItems.forEach(nav => nav.classList.remove('active'));
        item.classList.add('active');
      }
    });
  });

  // Update active nav on scroll
  if (content) {
    content.addEventListener('scroll', () => {
      const sections = document.querySelectorAll('.help-section');
      let currentSection = '';
      sections.forEach(section => {
        const sectionTop = section.offsetTop - content.offsetTop;
        if (content.scrollTop >= sectionTop - 50) {
          currentSection = section.id;
        }
      });
      navItems.forEach(item => {
        item.classList.remove('active');
        if (item.getAttribute('href') === '#' + currentSection) {
          item.classList.add('active');
        }
      });
    });
  }

  // Fetch version
  ipcRenderer.invoke('get-app-version').then(version => {
    const el = document.getElementById('help-app-version');
    if (el) el.textContent = `Version: ${version}`;
  }).catch(() => {});
}

function openHelpModal() {
  document.getElementById('help-modal-overlay').classList.add('visible');
}

function closeHelpModal() {
  document.getElementById('help-modal-overlay').classList.remove('visible');
}

function isHelpModalOpen() {
  return document.getElementById('help-modal-overlay').classList.contains('visible');
}

// ============================================
// Unified Keyboard Shortcuts
// ============================================

document.addEventListener('keydown', (e) => {
  const isInputFocused = document.activeElement &&
    (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');

  // Escape — close help modal or preview overlay (works in inputs too)
  if (e.key === 'Escape') {
    if (isHelpModalOpen()) {
      closeHelpModal();
      return;
    }
    const previewOverlay = document.getElementById('preview-overlay');
    if (previewOverlay.style.display !== 'none') {
      previewOverlay.style.display = 'none';
    }
    return;
  }

  // Ctrl+H — toggle help modal (works in inputs too)
  if (e.ctrlKey && e.key.toLowerCase() === 'h') {
    e.preventDefault();
    if (isHelpModalOpen()) {
      closeHelpModal();
    } else {
      openHelpModal();
    }
    return;
  }

  // Arrow Up/Down — cycle through variants (works everywhere, even in inputs)
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && variants.length > 0) {
    e.preventDefault();
    const currentIdx = variants.findIndex(v => v.id === selectedVariantId);
    let newIdx;
    if (e.key === 'ArrowUp') {
      newIdx = currentIdx <= 0 ? variants.length - 1 : currentIdx - 1;
    } else {
      newIdx = currentIdx >= variants.length - 1 ? 0 : currentIdx + 1;
    }
    selectVariant(variants[newIdx].id);
    return;
  }

  // Ctrl+J — duplicate selected variants
  if (e.ctrlKey && e.key.toLowerCase() === 'j' && variants.length > 0) {
    e.preventDefault();
    // Gather all selected variants (primary + multi-selected)
    const ids = new Set([selectedVariantId, ...selectedVariantIds]);
    const toDuplicate = variants.filter(v => ids.has(v.id));
    if (toDuplicate.length === 0) return;
    const newVariants = [];
    for (const src of toDuplicate) {
      const dup = {
        id: nextVariantId++,
        name: `${src.name} Copy`,
        isBase: false,
        layerStates: JSON.parse(JSON.stringify(src.layerStates)),
      };
      newVariants.push(dup);
    }
    variants.push(...newVariants);
    selectedVariantIds.clear();
    selectVariant(newVariants[0].id);
    for (let i = 1; i < newVariants.length; i++) selectedVariantIds.add(newVariants[i].id);
    renderVariantList();
    saveSidecar();
    showToast(`Duplicated ${toDuplicate.length} variant${toDuplicate.length > 1 ? 's' : ''}`);
    return;
  }

  // Ctrl+C — copy selected variants to clipboard (for cross-department paste)
  if (e.ctrlKey && e.key.toLowerCase() === 'c' && variants.length > 0) {
    e.preventDefault();
    const ids = new Set([selectedVariantId, ...selectedVariantIds]);
    const toCopy = variants.filter(v => ids.has(v.id));
    if (toCopy.length === 0) return;
    variantClipboard = toCopy.map(v => ({
      name: v.name,
      isBase: false,
      layerStates: JSON.parse(JSON.stringify(v.layerStates)),
    }));
    showToast(`Copied ${toCopy.length} variant${toCopy.length > 1 ? 's' : ''}`);
    return;
  }

  // Ctrl+V — paste variants from clipboard
  if (e.ctrlKey && e.key.toLowerCase() === 'v' && variantClipboard.length > 0) {
    e.preventDefault();
    const pasted = [];
    for (const src of variantClipboard) {
      const dup = {
        id: nextVariantId++,
        name: src.name,
        isBase: false,
        layerStates: JSON.parse(JSON.stringify(src.layerStates)),
      };
      // Reconcile: add missing layer states for this department, remove unknown ones
      const currentToggleNames = new Set(getUniqueToggleLayers().map(l => l.name));
      const currentGroupNames = new Set(getUniqueVariantGroups().map(g => g.name));
      const allCurrentNames = new Set([...currentToggleNames, ...currentGroupNames]);
      for (const key of Object.keys(dup.layerStates)) {
        if (!allCurrentNames.has(key)) delete dup.layerStates[key];
      }
      for (const name of currentToggleNames) {
        if (!(name in dup.layerStates)) dup.layerStates[name] = { visible: isPaintOverlay(name) };
      }
      for (const group of getUniqueVariantGroups()) {
        if (!(group.name in dup.layerStates)) dup.layerStates[group.name] = { selectedOption: group.options[0]?.name || null };
      }
      syncMergedVariantGroups(dup.layerStates);
      pasted.push(dup);
    }
    variants.push(...pasted);
    selectedVariantIds.clear();
    selectVariant(pasted[0].id);
    for (let i = 1; i < pasted.length; i++) selectedVariantIds.add(pasted[i].id);
    renderVariantList();
    saveSidecar();
    showToast(`Pasted ${pasted.length} variant${pasted.length > 1 ? 's' : ''}`);
    return;
  }

  // The following shortcuts are disabled when typing in inputs
  if (isInputFocused) return;

  // Ctrl+O — open PSD file
  if (e.ctrlKey && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    openPsdDialog();
    return;
  }

  // Ctrl+E — export all variants
  if (e.ctrlKey && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    exportAllVariants();
    return;
  }

  // Delete — delete selected variant
  if (e.key === 'Delete') {
    deleteSelectedVariant();
    return;
  }

  // Space — set hovered variant as template for new variants
  if (e.key === ' ' && hoveredVariantId != null) {
    e.preventDefault();
    const base = variants.find(v => v.isBase);
    // If already template, clear it (revert to base)
    if (templateVariantId === hoveredVariantId) {
      templateVariantId = null;
    } else {
      templateVariantId = hoveredVariantId;
    }
    renderVariantList();
    showToast(templateVariantId != null
      ? `Template set to "${variants.find(v => v.id === templateVariantId)?.name}"`
      : 'Template reset to Base');
    return;
  }
});

// ============================================
// Export Sizes
// ============================================

function renderExportSizes() {
  const container = document.getElementById('export-sizes');
  container.innerHTML = '';

  for (const size of exportSizes) {
    const chip = document.createElement('span');
    chip.className = 'export-size-chip';
    chip.innerHTML = `${size}px <span class="remove-size" data-size="${size}">&times;</span>`;
    container.appendChild(chip);
  }
}

function addExportSize(width) {
  width = Math.round(width);
  if (width < 1 || width > 16384) {
    showToast('Size must be between 1 and 16384', 'warning');
    return;
  }
  if (exportSizes.includes(width)) {
    showToast(`${width}px already added`, 'warning');
    return;
  }
  exportSizes.push(width);
  exportSizes.sort((a, b) => b - a);
  renderExportSizes();
  saveSidecar();
}

function removeExportSize(width) {
  if (exportSizes.length <= 1) {
    showToast('Need at least one export size', 'warning');
    return;
  }
  exportSizes = exportSizes.filter(s => s !== width);
  renderExportSizes();
  saveSidecar();
}

// Wire up export size controls
document.getElementById('export-sizes').addEventListener('click', (e) => {
  const removeBtn = e.target.closest('.remove-size');
  if (removeBtn) {
    removeExportSize(parseInt(removeBtn.dataset.size));
  }
});

document.getElementById('btn-add-size').addEventListener('click', () => {
  const input = document.getElementById('export-size-input');
  const val = parseInt(input.value);
  if (val) {
    addExportSize(val);
    input.value = '';
  }
});

document.getElementById('export-size-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = parseInt(e.target.value);
    if (val) {
      addExportSize(val);
      e.target.value = '';
    }
  }
});

// Initialize default sizes display
renderExportSizes();

// ============================================
// Export Engine
// ============================================

// Render a variant's composite to a clean canvas (no checkerboard)
function renderExportCanvas(variant, deptIndex) {
  const canvas = document.createElement('canvas');
  canvas.width = currentPsd.width;
  canvas.height = currentPsd.height;
  const ctx = canvas.getContext('2d');

  const di = deptIndex != null ? deptIndex : selectedDepartmentIndex;
  drawChildren(ctx, getEffectiveChildren(di), variant.layerStates, null, false, false);

  return canvas;
}

// Scale a canvas to a target width (maintains aspect ratio)
function scaleCanvas(srcCanvas, targetWidth) {
  if (targetWidth === srcCanvas.width) return srcCanvas;

  const scale = targetWidth / srcCanvas.width;
  const targetHeight = Math.round(srcCanvas.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight);

  return canvas;
}

// Convert a canvas to a PNG buffer
function canvasToBuffer(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(new Error('Failed to create PNG blob'));
        return;
      }
      blob.arrayBuffer().then(ab => {
        resolve(Buffer.from(ab));
      }).catch(reject);
    }, 'image/png');
  });
}

// Get the export file path for a variant + size (relative to output directory)
// Get the area name from a variant's selected option in merged variant groups
function getVariantAreaName(variant) {
  const groups = getUniqueVariantGroups();
  const mergedMap = new Map();
  for (const group of groups) {
    const optionKey = getOptionMergeKey(group);
    if (!mergedMap.has(optionKey)) mergedMap.set(optionKey, []);
    mergedMap.get(optionKey).push(group.name);
  }
  // Find the first merged group (multiple groups with same options = area)
  for (const [, groupNames] of mergedMap) {
    if (groupNames.length > 1) {
      const state = variant.layerStates[groupNames[0]];
      if (state && state.selectedOption) return state.selectedOption;
    }
  }
  // Fall back to first variant group's selection
  if (groups.length > 0) {
    const state = variant.layerStates[groups[0].name];
    if (state && state.selectedOption) return state.selectedOption;
  }
  return null;
}

function sanitizePathComponent(name) {
  return name.replace(/\.\./g, '').replace(/[/\\:*?"<>|\x00]/g, '_').trim() || '_';
}

function getExportFilePath(variant, size, hasMultipleSizes, deptName) {
  const stem = path.basename(currentFilePath, '.psd');
  let name = stem;

  // Add variant name unless it's the default "Base"
  if (variant.name.toLowerCase() !== 'base') {
    name += ` ${sanitizePathComponent(variant.name)}`;
  }

  const fileName = `${name}.png`;
  const parts = [];

  // Department subfolder when multi-department
  if (deptName) {
    parts.push(sanitizePathComponent(deptName));
  }

  // Size subfolder when exporting at multiple sizes
  if (hasMultipleSizes) {
    parts.push(String(size));
  }

  // Area subfolder when organize by area is enabled
  if (organizeByArea) {
    const area = getVariantAreaName(variant);
    if (area) parts.push(sanitizePathComponent(area));
  }

  if (parts.length > 0) {
    return path.join(...parts, fileName);
  }

  return fileName;
}

// Export all variants at all sizes
async function exportAllVariants() {
  if (!currentPsd || variants.length === 0) {
    showToast('No PSD loaded', 'warning');
    return;
  }

  if (isExporting) return;

  // Prompt for output directory if not set
  if (!outputDirectory) {
    const defaultDir = currentFilePath ? path.dirname(currentFilePath) : undefined;
    const dir = await ipcRenderer.invoke('select-output-directory', defaultDir);
    if (!dir) return;
    outputDirectory = dir;
    document.getElementById('output-path').textContent = dir;
    saveSidecar();
  }

  // Verify output directory still exists
  if (!fs.existsSync(outputDirectory)) {
    showToast('Output folder no longer exists', 'error');
    outputDirectory = null;
    document.getElementById('output-path').textContent = 'Not set';
    return;
  }

  isExporting = true;
  const btn = document.getElementById('btn-export-all');
  const originalText = btn.textContent;
  btn.disabled = true;

  // Build list of export jobs: [{variant, deptIndex, deptName}]
  const jobs = [];
  if (departments) {
    saveDepartmentState();
    for (let di = 0; di < departments.length; di++) {
      for (const variant of departments[di].variants) {
        jobs.push({ variant, deptIndex: di, deptName: departments[di].name });
      }
    }
  } else {
    for (const variant of variants) {
      jobs.push({ variant, deptIndex: 0, deptName: null });
    }
  }

  const hasMultipleSizes = exportSizes.length > 1;
  const totalSteps = jobs.length * exportSizes.length;
  let currentStep = 0;
  let exported = 0;
  let errors = 0;

  try {
    for (const job of jobs) {
      // Set classifiedLayers for correct area name resolution during export
      if (departments) loadDepartmentIntoGlobals(job.deptIndex);
      const fullCanvas = renderExportCanvas(job.variant, job.deptIndex);

      for (const size of exportSizes) {
        currentStep++;
        btn.textContent = `Exporting ${currentStep}/${totalSteps}...`;

        try {
          const scaled = scaleCanvas(fullCanvas, size);
          const buffer = await canvasToBuffer(scaled);
          const relPath = getExportFilePath(job.variant, size, hasMultipleSizes, job.deptName);
          const filePath = path.join(outputDirectory, relPath);

          const fileDir = path.dirname(filePath);
          if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

          fs.writeFileSync(filePath, buffer);
          exported++;
        } catch (err) {
          console.error(`Export error for "${job.variant.name}" at ${size}px:`, err);
          errors++;
        }

        await new Promise(r => setTimeout(r, 10));
      }
    }

    if (errors === 0) {
      showToast(`Exported ${exported} file${exported !== 1 ? 's' : ''} to ${outputDirectory}`, 'success', 5000);
    } else {
      showToast(`Exported ${exported} files with ${errors} error${errors !== 1 ? 's' : ''}`, 'warning', 5000);
    }
  } catch (err) {
    console.error('Export failed:', err);
    showToast(`Export failed: ${err.message}`, 'error');
  } finally {
    // Restore active department after export
    if (departments) loadDepartmentIntoGlobals(selectedDepartmentIndex);
    isExporting = false;
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ============================================
// Drop Zone & File Input
// ============================================

const dropZone = document.getElementById('drop-zone');
const dropZoneInner = document.getElementById('drop-zone-inner');

dropZoneInner.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZoneInner.classList.add('drag-over');
});

dropZoneInner.addEventListener('dragleave', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZoneInner.classList.remove('drag-over');
});

dropZoneInner.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZoneInner.classList.remove('drag-over');

  const files = e.dataTransfer.files;
  if (files.length > 0) {
    const filePath = files[0].path;
    if (filePath.toLowerCase().endsWith('.psd')) {
      loadPsdFile(filePath);
    } else {
      showToast('Please drop a .psd file', 'warning');
    }
  }
});

dropZoneInner.addEventListener('click', () => {
  if (dropZone.classList.contains('file-loaded')) return;
  openPsdDialog();
});

document.getElementById('btn-change-file').addEventListener('click', (e) => {
  e.stopPropagation();
  openPsdDialog();
});

// ============================================
// Button Wiring
// ============================================

// Variant list — event delegation for click + double-click rename
let variantLastClickId = null;
let variantLastClickTime = 0;

document.getElementById('variant-list').addEventListener('click', (e) => {
  const item = e.target.closest('.variant-item');
  if (!item) return;
  if (e.target.classList.contains('variant-item-rename')) return;

  const id = parseInt(item.dataset.variantId);
  const now = Date.now();

  if (e.ctrlKey || e.metaKey) {
    // Ctrl+Click: toggle multi-select
    if (id === selectedVariantId) return; // can't deselect primary
    if (selectedVariantIds.has(id)) {
      selectedVariantIds.delete(id);
    } else {
      selectedVariantIds.add(id);
    }
    renderVariantList();
    return;
  }

  if (variantLastClickId === id && (now - variantLastClickTime) < 400) {
    // Double-click: select then rename
    const variant = variants.find(v => v.id === id);
    if (variant) {
      selectedVariantIds.clear();
      selectVariant(id);
      const freshItem = document.querySelector(`.variant-item[data-variant-id="${id}"]`);
      if (freshItem) {
        const nameSpan = freshItem.querySelector('.variant-item-name');
        if (nameSpan) startInlineRename(variant, nameSpan);
      }
    }
    variantLastClickId = null;
    variantLastClickTime = 0;
  } else {
    selectedVariantIds.clear();
    selectVariant(id);
    variantLastClickId = id;
    variantLastClickTime = now;
  }
});

document.getElementById('btn-add-variant').addEventListener('click', addVariant);

document.getElementById('btn-delete-variant').addEventListener('click', deleteSelectedVariant);

// Variant name input — update selected variant name on change
document.getElementById('variant-name').addEventListener('input', (e) => {
  const variant = getSelectedVariant();
  if (variant) {
    variant.name = e.target.value;
    // Update the variant list item text without full re-render
    const item = document.querySelector(`.variant-item[data-variant-id="${variant.id}"] .variant-item-name`);
    if (item) item.textContent = variant.name;
    // Update count display
    document.getElementById('variant-count').textContent = variants.length;
    saveSidecar();
  }
});

// Check for duplicate name on blur
document.getElementById('variant-name').addEventListener('blur', (e) => {
  const variant = getSelectedVariant();
  if (variant) {
    checkDuplicateVariantName(variant.name, variant.id);
  }
});

// Output folder
document.getElementById('btn-browse-output').addEventListener('click', async () => {
  const defaultDir = outputDirectory || (currentFilePath ? path.dirname(currentFilePath) : undefined);
  const dir = await ipcRenderer.invoke('select-output-directory', defaultDir);
  if (dir) {
    outputDirectory = dir;
    document.getElementById('output-path').textContent = dir;
    saveSidecar();
  }
});

// Organize by area checkbox
document.getElementById('chk-organize-by-area').addEventListener('change', (e) => {
  organizeByArea = e.target.checked;
  saveSidecar();
});

// Export
document.getElementById('btn-export-all').addEventListener('click', exportAllVariants);

// ============================================
// Init
// ============================================

initHelpModal();
console.log('LiveryLab Export initialized');
