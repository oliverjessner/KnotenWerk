/*
KnotenWerk (Tauri + Vanilla JS)

Run:
1) npm install
2) npm run tauri dev

Build:
1) npm run tauri build
*/

import { BaseDirectory, appDataDir } from '@tauri-apps/api/path';
import {
  exists,
  mkdir,
  readDir,
  readTextFile,
  remove,
  stat,
  writeTextFile
} from '@tauri-apps/plugin-fs';
import { confirm, open, save } from '@tauri-apps/plugin-dialog';

const GRAPH_VERSION = 1;
const GRAPHS_DIR = 'graphs';
const AUTOSAVE_DELAY_MS = 500;
const NODE_WIDTH = 190;
const DEFAULT_NODE_TYPE = 'xor';
const DEFAULT_NODE_COLOR = '#d4d0c8';
const ZOOM_LEVELS = [0.3, 0.5, 0.7, 0.85, 1, 1.1, 1.2, 1.3, 1.4];
const DEFAULT_ZOOM_INDEX = Math.max(0, ZOOM_LEVELS.indexOf(1));

const state = {
  graphSummaries: [],
  currentGraph: null,
  mode: 'edit',
  selectedEdgeId: null,
  selectedEdgeSelectionSource: null,
  pendingChoice: null,
  dragging: null,
  autosaveHandle: null,
  modalResolver: null,
  modalOptions: null,
  nodeElements: new Map(),
  lastChosenEdgeId: null,
  lastChosenNodeId: null,
  colorPickerNodeId: null,
  eightBitPalette: [],
  viewportOffset: { x: 0, y: 0 },
  zoomLevelIndex: DEFAULT_ZOOM_INDEX,
  edgeConnectDrag: null,
  panning: null,
  suppressBackgroundClickOnce: false
};

const el = {};

document.addEventListener('DOMContentLoaded', () => {
  initialize().catch(async (error) => {
    console.error('Failed to initialize app:', error);
    await showAlert(
      'KnotenWerk could not initialize.\n\nMake sure you launch it with `npm run tauri dev`.'
    );
  });
});

async function initialize() {
  cacheElements();
  state.eightBitPalette = buildEightBitPalette();
  renderColorPickerGrid();
  bindEvents();
  updateZoomUi();
  applyViewportTransform();

  await ensureGraphsDirectory();
  await refreshGraphList();

  if (state.graphSummaries.length === 0) {
    const starter = createGraph('New Graph');
    await persistGraph(starter);
    upsertGraphSummary(starter);
    renderGraphList();
    await loadGraphById(starter.id);
  } else {
    await loadGraphFromSummary(state.graphSummaries[0]);
  }

  setMode('edit');
  setStatus('Ready.');
}

function cacheElements() {
  el.graphList = document.getElementById('graph-list');
  el.currentGraphName = document.getElementById('current-graph-name');
  el.editorSurface = document.getElementById('editor-surface');
  el.edgeLayer = document.getElementById('edge-layer');
  el.edgeControlLayer = document.getElementById('edge-control-layer');
  el.nodeLayer = document.getElementById('node-layer');
  el.zoomControl = document.getElementById('zoom-control');
  el.zoomSlider = document.getElementById('zoom-slider');
  el.zoomValue = document.getElementById('zoom-value');
  el.zoomResetBtn = document.getElementById('zoom-reset-btn');
  el.emptyState = document.getElementById('empty-state');
  el.statusText = document.getElementById('status-text');

  el.newGraphBtn = document.getElementById('new-graph-btn');
  el.renameGraphBtn = document.getElementById('rename-graph-btn');
  el.duplicateGraphBtn = document.getElementById('duplicate-graph-btn');
  el.deleteGraphBtn = document.getElementById('delete-graph-btn');
  el.exportGraphBtn = document.getElementById('export-graph-btn');
  el.importGraphBtn = document.getElementById('import-graph-btn');

  el.addNodeBtn = document.getElementById('add-node-btn');
  el.addChoiceBtn = document.getElementById('add-choice-btn');
  el.editNodeBtn = document.getElementById('edit-node-btn');
  el.nodeColorBtn = document.getElementById('node-color-btn');
  el.editChoiceBtn = document.getElementById('edit-choice-btn');
  el.deleteNodeBtn = document.getElementById('delete-node-btn');
  el.deleteChoiceBtn = document.getElementById('delete-choice-btn');
  el.clearPathBtn = document.getElementById('clear-path-btn');

  el.modeRadios = Array.from(document.querySelectorAll('input[name="mode"]'));

  el.colorPickerOverlay = document.getElementById('color-picker-overlay');
  el.colorPickerGrid = document.getElementById('color-picker-grid');
  el.colorPickerCurrent = document.getElementById('color-picker-current');
  el.colorPickerDefault = document.getElementById('color-picker-default');
  el.colorPickerCancel = document.getElementById('color-picker-cancel');

  el.modalOverlay = document.getElementById('modal-overlay');
  el.modalTitle = document.getElementById('modal-title');
  el.modalMessage = document.getElementById('modal-message');
  el.modalInput = document.getElementById('modal-input');
  el.modalSelect = document.getElementById('modal-select');
  el.modalOk = document.getElementById('modal-ok');
  el.modalCancel = document.getElementById('modal-cancel');
}

function bindEvents() {
  el.newGraphBtn.addEventListener('click', createNewGraphFlow);
  el.renameGraphBtn.addEventListener('click', renameCurrentGraphFlow);
  el.duplicateGraphBtn.addEventListener('click', duplicateCurrentGraphFlow);
  el.deleteGraphBtn.addEventListener('click', deleteCurrentGraphFlow);
  el.exportGraphBtn.addEventListener('click', exportCurrentGraph);
  el.importGraphBtn.addEventListener('click', importGraphFromJson);

  el.addNodeBtn.addEventListener('click', () => addNodeAtDefaultPosition());
  el.addChoiceBtn.addEventListener('click', addChoiceFlow);
  el.editNodeBtn.addEventListener('click', () => editSelectedNodeTextFlow());
  el.nodeColorBtn.addEventListener('click', openNodeColorPicker);
  el.editChoiceBtn.addEventListener('click', () => editSelectedChoiceTextFlow());
  el.deleteNodeBtn.addEventListener('click', deleteSelectedNodeFlow);
  el.deleteChoiceBtn.addEventListener('click', deleteSelectedChoiceFlow);
  el.clearPathBtn.addEventListener('click', clearActivePath);

  el.modeRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) {
        setMode(radio.value);
      }
    });
  });

  el.graphList.addEventListener('click', async (event) => {
    const button = event.target.closest('.graph-item__btn');
    if (!button) {
      return;
    }

    const graphId = button.dataset.graphId;
    if (!graphId) {
      return;
    }

    await loadGraphById(graphId);
  });

  el.editorSurface.addEventListener('dblclick', handleEditorDoubleClick);
  el.editorSurface.addEventListener('click', handleEditorBackgroundClick);
  el.editorSurface.addEventListener('mousedown', handleEditorSurfaceMouseDown);
  el.zoomSlider.addEventListener('input', handleZoomSliderInput);
  el.zoomResetBtn.addEventListener('click', () => setZoomLevelIndex(DEFAULT_ZOOM_INDEX));

  el.nodeLayer.addEventListener('click', handleNodeLayerClick);
  el.nodeLayer.addEventListener('dblclick', handleNodeLayerDoubleClick);
  el.nodeLayer.addEventListener('mousedown', handleNodeLayerMouseDown);

  el.edgeLayer.addEventListener('click', handleEdgeLayerClick);
  el.edgeLayer.addEventListener('mousedown', handleEdgeLayerMouseDown);
  el.edgeLayer.addEventListener('dblclick', handleEdgeLayerDoubleClick);
  el.edgeControlLayer.addEventListener('click', handleEdgeControlLayerClick);
  el.edgeControlLayer.addEventListener('dblclick', handleEdgeControlLayerDoubleClick);

  window.addEventListener('mousemove', handleWindowMouseMove);
  window.addEventListener('mouseup', handleWindowMouseUp);

  el.modalOk.addEventListener('click', () => resolveModal(true));
  el.modalCancel.addEventListener('click', () => resolveModal(false));
  el.modalOverlay.addEventListener('click', (event) => {
    if (event.target === el.modalOverlay) {
      resolveModal(false);
    }
  });

  window.addEventListener('keydown', (event) => {
    if (!el.colorPickerOverlay.classList.contains('hidden') && event.key === 'Escape') {
      event.preventDefault();
      closeNodeColorPicker();
      return;
    }

    if (!state.modalResolver) {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      resolveModal(false);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      resolveModal(true);
    }
  });

  el.colorPickerGrid.addEventListener('click', (event) => {
    const swatch = event.target.closest('.color-swatch');
    if (!swatch || !state.colorPickerNodeId) {
      return;
    }

    const color = swatch.dataset.color;
    if (!color) {
      return;
    }

    applyNodeColor(state.colorPickerNodeId, color);
    closeNodeColorPicker();
  });

  el.colorPickerDefault.addEventListener('click', () => {
    if (!state.colorPickerNodeId) {
      return;
    }
    applyNodeColor(state.colorPickerNodeId, null);
    closeNodeColorPicker();
  });

  el.colorPickerCancel.addEventListener('click', closeNodeColorPicker);
  el.colorPickerOverlay.addEventListener('click', (event) => {
    if (event.target === el.colorPickerOverlay) {
      closeNodeColorPicker();
    }
  });
}

function setStatus(text) {
  el.statusText.textContent = text;
}

function currentZoom() {
  return ZOOM_LEVELS[state.zoomLevelIndex] || 1;
}

function updateZoomUi() {
  if (!el.zoomSlider || !el.zoomValue) {
    return;
  }

  const zoom = currentZoom();
  el.zoomSlider.min = '0';
  el.zoomSlider.max = String(ZOOM_LEVELS.length - 1);
  el.zoomSlider.value = String(state.zoomLevelIndex);
  el.zoomValue.textContent = `${Math.round(zoom * 100)}%`;
}

function setZoomLevelIndex(nextIndex) {
  const normalizedIndex = clamp(Math.round(nextIndex), 0, ZOOM_LEVELS.length - 1);
  if (normalizedIndex === state.zoomLevelIndex) {
    updateZoomUi();
    return;
  }

  const previousZoom = currentZoom();
  const nextZoom = ZOOM_LEVELS[normalizedIndex];
  const width = el.editorSurface.clientWidth || 0;
  const height = el.editorSurface.clientHeight || 0;
  const centerX = width / 2;
  const centerY = height / 2;
  const worldCenterX = (centerX - state.viewportOffset.x) / previousZoom;
  const worldCenterY = (centerY - state.viewportOffset.y) / previousZoom;

  state.zoomLevelIndex = normalizedIndex;
  state.viewportOffset.x = centerX - worldCenterX * nextZoom;
  state.viewportOffset.y = centerY - worldCenterY * nextZoom;

  updateZoomUi();
  applyViewportTransform();
  setStatus(`Zoom: ${Math.round(nextZoom * 100)}%`);
}

function handleZoomSliderInput(event) {
  const rawValue = Number.parseInt(event.target.value, 10);
  if (Number.isNaN(rawValue)) {
    return;
  }

  setZoomLevelIndex(rawValue);
}

function setMode(nextMode) {
  state.mode = nextMode === 'view' ? 'view' : 'edit';
  document.body.dataset.mode = state.mode;

  el.modeRadios.forEach((radio) => {
    radio.checked = radio.value === state.mode;
  });

  if (state.mode === 'view') {
    ensureActivePathSeed();
    state.pendingChoice = null;
    closeNodeColorPicker();
  }

  renderGraph();
  updateActionButtons();
  setStatus(state.mode === 'view' ? 'View mode enabled.' : 'Edit mode enabled.');
}

function uid(prefix) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function nowISO() {
  return new Date().toISOString();
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown date';
  }
  return date.toLocaleString();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'graph';
}

function formatDateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b]
    .map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

function hexToRgb(hex) {
  const normalized = normalizeHexColor(hex);
  if (!normalized) {
    return null;
  }

  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16)
  };
}

function normalizeHexColor(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const raw = value.trim().toLowerCase();
  if (!raw) {
    return null;
  }

  if (/^#[0-9a-f]{6}$/.test(raw)) {
    return raw;
  }

  if (/^#[0-9a-f]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  }

  return null;
}

function mixColor(hex, amount) {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return hex;
  }

  const delta = clamp(amount, -1, 1);
  if (delta >= 0) {
    return rgbToHex(
      rgb.r + (255 - rgb.r) * delta,
      rgb.g + (255 - rgb.g) * delta,
      rgb.b + (255 - rgb.b) * delta
    );
  }

  const factor = 1 + delta;
  return rgbToHex(rgb.r * factor, rgb.g * factor, rgb.b * factor);
}

function getReadableTextColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return '#000000';
  }

  const luminance = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  return luminance < 145 ? '#ffffff' : '#000000';
}

function buildEightBitPalette() {
  const base = [
    '#000000',
    '#800000',
    '#008000',
    '#808000',
    '#000080',
    '#800080',
    '#008080',
    '#c0c0c0',
    '#808080',
    '#ff0000',
    '#00ff00',
    '#ffff00',
    '#0000ff',
    '#ff00ff',
    '#00ffff',
    '#ffffff'
  ];

  const colors = [...base];
  const steps = [0, 95, 135, 175, 215, 255];

  for (let r = 0; r < 6; r += 1) {
    for (let g = 0; g < 6; g += 1) {
      for (let b = 0; b < 6; b += 1) {
        colors.push(rgbToHex(steps[r], steps[g], steps[b]));
      }
    }
  }

  for (let i = 0; i < 24; i += 1) {
    const value = 8 + i * 10;
    colors.push(rgbToHex(value, value, value));
  }

  return colors.slice(0, 256);
}

function getNodeBaseColor(node) {
  return normalizeHexColor(node?.color) || DEFAULT_NODE_COLOR;
}

function renderColorPickerGrid() {
  if (!el.colorPickerGrid) {
    return;
  }

  el.colorPickerGrid.innerHTML = '';

  state.eightBitPalette.forEach((color, index) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-swatch';
    swatch.dataset.color = color;
    swatch.title = `${index.toString().padStart(3, '0')} ${color.toUpperCase()}`;
    swatch.style.backgroundColor = color;
    el.colorPickerGrid.appendChild(swatch);
  });
}

function refreshColorPickerSelection(node) {
  if (!el.colorPickerGrid || !el.colorPickerCurrent) {
    return;
  }

  const color = normalizeHexColor(node?.color);

  el.colorPickerGrid.querySelectorAll('.color-swatch').forEach((swatch) => {
    swatch.classList.toggle('is-selected', color === swatch.dataset.color);
  });

  if (color) {
    el.colorPickerCurrent.textContent = `Selected: ${color.toUpperCase()}`;
  } else {
    el.colorPickerCurrent.textContent = 'Selected: Default';
  }
}

function openNodeColorPicker() {
  if (!state.currentGraph || state.mode !== 'edit') {
    return;
  }

  if (!el.colorPickerOverlay) {
    return;
  }

  const nodeId = state.currentGraph.ui.selectedNodeId;
  const node = findNode(nodeId);
  if (!node) {
    void showAlert('Select a node first.');
    return;
  }

  state.colorPickerNodeId = node.id;
  refreshColorPickerSelection(node);
  el.colorPickerOverlay.classList.remove('hidden');
}

function closeNodeColorPicker() {
  state.colorPickerNodeId = null;
  if (el.colorPickerOverlay) {
    el.colorPickerOverlay.classList.add('hidden');
  }
}

function applyNodeColor(nodeId, color) {
  if (!state.currentGraph) {
    return;
  }

  const node = findNode(nodeId);
  if (!node) {
    return;
  }

  node.color = normalizeHexColor(color);
  renderGraph();
  scheduleAutosave();
  setStatus(node.color ? `Node color set to ${node.color.toUpperCase()}` : 'Node color reset to default.');
}

function normalizeNodeType(value) {
  return String(value || '').trim().toLowerCase() === 'or' ? 'or' : 'xor';
}

function createGraph(name) {
  const createdAt = nowISO();
  const startNode = {
    id: uid('n'),
    x: 220,
    y: 120,
    text: 'Start',
    type: DEFAULT_NODE_TYPE,
    color: null,
    buttons: []
  };

  return {
    id: uid('g'),
    name: name || 'New Graph',
    version: GRAPH_VERSION,
    createdAt,
    updatedAt: createdAt,
    nodes: [startNode],
    edges: [],
    ui: {
      selectedNodeId: startNode.id,
      activePath: [],
      activeSelections: {}
    }
  };
}

async function generateUniqueGraphId() {
  let nextId = uid('g');

  while (true) {
    const usedInMemory = state.graphSummaries.some((item) => item.id === nextId);
    const usedOnDisk = await exists(graphPath(nextId), { baseDir: BaseDirectory.AppData });
    if (!usedInMemory && !usedOnDisk) {
      return nextId;
    }
    nextId = uid('g');
  }
}

function normalizeGraph(input, sourceLabel = 'graph') {
  if (!input || typeof input !== 'object') {
    throw new Error(`${sourceLabel}: root must be an object.`);
  }

  if (typeof input.version === 'number' && input.version > GRAPH_VERSION) {
    throw new Error(`${sourceLabel}: unsupported graph version ${input.version}.`);
  }

  if (!Array.isArray(input.nodes)) {
    throw new Error(`${sourceLabel}: nodes must be an array.`);
  }

  if (!Array.isArray(input.edges)) {
    throw new Error(`${sourceLabel}: edges must be an array.`);
  }

  const graph = {
    id: typeof input.id === 'string' && input.id ? input.id : uid('g'),
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Untitled Graph',
    version: GRAPH_VERSION,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : nowISO(),
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : nowISO(),
    nodes: [],
    edges: [],
    ui: {
      selectedNodeId:
        typeof input.ui?.selectedNodeId === 'string' ? input.ui.selectedNodeId : null,
      activePath: Array.isArray(input.ui?.activePath)
        ? input.ui.activePath.filter((entry) => typeof entry === 'string')
        : [],
      activeSelections:
        input.ui?.activeSelections &&
        typeof input.ui.activeSelections === 'object' &&
        !Array.isArray(input.ui.activeSelections)
          ? input.ui.activeSelections
          : {}
    }
  };

  const nodeIdSet = new Set();

  input.nodes.forEach((rawNode, index) => {
    if (!rawNode || typeof rawNode !== 'object') {
      return;
    }

    let nodeId =
      typeof rawNode.id === 'string' && rawNode.id.trim() ? rawNode.id.trim() : uid('n');
    while (nodeIdSet.has(nodeId)) {
      nodeId = uid('n');
    }
    nodeIdSet.add(nodeId);

    const buttons = [];
    const buttonSet = new Set();

    if (Array.isArray(rawNode.buttons)) {
      rawNode.buttons.forEach((rawButton) => {
        if (!rawButton || typeof rawButton !== 'object') {
          return;
        }

        let buttonId =
          typeof rawButton.id === 'string' && rawButton.id.trim()
            ? rawButton.id.trim()
            : uid('b');

        while (buttonSet.has(buttonId)) {
          buttonId = uid('b');
        }
        buttonSet.add(buttonId);

        buttons.push({
          id: buttonId,
          text:
            typeof rawButton.text === 'string' && rawButton.text.trim()
              ? rawButton.text.trim()
              : 'Choice',
          to:
            typeof rawButton.to === 'string' && rawButton.to.trim()
              ? rawButton.to.trim()
              : null
        });
      });
    }

    graph.nodes.push({
      id: nodeId,
      x: Number.isFinite(rawNode.x) ? rawNode.x : 140 + index * 30,
      y: Number.isFinite(rawNode.y) ? rawNode.y : 100 + index * 30,
      text:
        typeof rawNode.text === 'string' && rawNode.text.trim()
          ? rawNode.text.trim()
          : `Node ${index + 1}`,
      type: normalizeNodeType(rawNode.type),
      color: normalizeHexColor(rawNode.color),
      buttons
    });
  });

  if (graph.nodes.length === 0) {
    graph.nodes.push({
      id: uid('n'),
      x: 220,
      y: 120,
      text: 'Start',
      type: DEFAULT_NODE_TYPE,
      color: null,
      buttons: []
    });
  }

  const edgeIdSet = new Set();

  input.edges.forEach((rawEdge) => {
    if (!rawEdge || typeof rawEdge !== 'object') {
      return;
    }

    if (typeof rawEdge.from !== 'string') {
      return;
    }

    const fromId = rawEdge.from.trim();
    const toId =
      typeof rawEdge.to === 'string' && rawEdge.to.trim() ? rawEdge.to.trim() : null;

    if (!fromId) {
      return;
    }

    if (!graph.nodes.some((node) => node.id === fromId)) {
      return;
    }

    if (toId && !graph.nodes.some((node) => node.id === toId)) {
      return;
    }

    let edgeId =
      typeof rawEdge.id === 'string' && rawEdge.id.trim() ? rawEdge.id.trim() : uid('e');
    while (edgeIdSet.has(edgeId)) {
      edgeId = uid('e');
    }
    edgeIdSet.add(edgeId);

    graph.edges.push({
      id: edgeId,
      from: fromId,
      to: toId,
      buttonId:
        typeof rawEdge.buttonId === 'string' && rawEdge.buttonId.trim()
          ? rawEdge.buttonId.trim()
          : uid('b'),
      pendingX: Number.isFinite(rawEdge.pendingX) ? rawEdge.pendingX : null,
      pendingY: Number.isFinite(rawEdge.pendingY) ? rawEdge.pendingY : null
    });
  });

  enforceGraphConsistency(graph);
  return graph;
}

function getActiveSelections(graph) {
  if (!graph.ui || typeof graph.ui !== 'object') {
    graph.ui = {};
  }

  if (
    !graph.ui.activeSelections ||
    typeof graph.ui.activeSelections !== 'object' ||
    Array.isArray(graph.ui.activeSelections)
  ) {
    graph.ui.activeSelections = {};
  }

  return graph.ui.activeSelections;
}

function rebuildActivePathFromSelections(graph) {
  const rootNodeId = graph.nodes[0]?.id;
  if (!rootNodeId) {
    graph.ui.activePath = [];
    graph.ui.activeSelections = {};
    return;
  }

  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const selections = getActiveSelections(graph);
  const nextPath = [];

  const walk = (nodeId, stack = new Set()) => {
    const node = nodeById.get(nodeId);
    if (!node) {
      return;
    }

    nextPath.push(nodeId);

    if (stack.has(nodeId)) {
      return;
    }

    const nextStack = new Set(stack);
    nextStack.add(nodeId);

    const rawSelected = Array.isArray(selections[nodeId]) ? selections[nodeId] : [];
    const selectedEdgeIds = node.type === 'xor' ? rawSelected.slice(0, 1) : rawSelected;

    selectedEdgeIds.forEach((edgeId) => {
      const edge = edgeById.get(edgeId);
      if (!edge || edge.from !== nodeId || typeof edge.to !== 'string' || !nodeById.has(edge.to)) {
        return;
      }

      nextPath.push(edge.id);
      walk(edge.to, nextStack);
    });
  };

  walk(rootNodeId);
  graph.ui.activePath = nextPath;

  const activeNodeIds = new Set();
  const activeEdgeIds = new Set();
  const nodeIdSet = new Set(graph.nodes.map((node) => node.id));
  const edgeIdSet = new Set(graph.edges.map((edge) => edge.id));

  nextPath.forEach((entry) => {
    if (nodeIdSet.has(entry)) {
      activeNodeIds.add(entry);
    } else if (edgeIdSet.has(entry)) {
      activeEdgeIds.add(entry);
    }
  });

  const prunedSelections = {};
  Object.entries(selections).forEach(([nodeId, edgeIds]) => {
    if (!activeNodeIds.has(nodeId) || !Array.isArray(edgeIds)) {
      return;
    }

    const filtered = [];
    edgeIds.forEach((edgeId) => {
      if (typeof edgeId === 'string' && activeEdgeIds.has(edgeId) && !filtered.includes(edgeId)) {
        filtered.push(edgeId);
      }
    });

    if (filtered.length > 0) {
      prunedSelections[nodeId] = filtered;
    }
  });

  graph.ui.activeSelections = prunedSelections;
}

function enforceGraphConsistency(graph) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  graph.edges = graph.edges.filter((edge) => {
    if (!nodeById.has(edge.from)) {
      return false;
    }

    if (typeof edge.to === 'string' && edge.to.trim()) {
      edge.to = edge.to.trim();
      edge.pendingX = null;
      edge.pendingY = null;
      return nodeById.has(edge.to);
    }

    edge.to = null;
    edge.pendingX = Number.isFinite(edge.pendingX) ? edge.pendingX : null;
    edge.pendingY = Number.isFinite(edge.pendingY) ? edge.pendingY : null;
    return true;
  });

  const outgoingByNode = new Map();
  graph.edges.forEach((edge) => {
    const list = outgoingByNode.get(edge.from) || [];
    list.push(edge);
    outgoingByNode.set(edge.from, list);
  });

  graph.nodes.forEach((node) => {
    node.type = normalizeNodeType(node.type);
    node.color = normalizeHexColor(node.color);

    const outgoing = outgoingByNode.get(node.id) || [];
    const buttonById = new Map((node.buttons || []).map((button) => [button.id, button]));

    outgoing.forEach((edge) => {
      let button = buttonById.get(edge.buttonId);
      if (!button) {
        button = { id: edge.buttonId, text: 'Choice', to: edge.to };
        node.buttons.push(button);
        buttonById.set(edge.buttonId, button);
      }
      button.to = typeof edge.to === 'string' && edge.to ? edge.to : null;
      if (!button.text || typeof button.text !== 'string') {
        button.text = 'Choice';
      }
    });

    const validButtonIds = new Set(outgoing.map((edge) => edge.buttonId));
    node.buttons = node.buttons.filter((button) => validButtonIds.has(button.id));
  });

  const nodeIdSet = new Set(graph.nodes.map((node) => node.id));
  const edgeIdSet = new Set(graph.edges.map((edge) => edge.id));
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));

  graph.ui.selectedNodeId = nodeIdSet.has(graph.ui.selectedNodeId)
    ? graph.ui.selectedNodeId
    : null;

  const currentSelections = getActiveSelections(graph);
  const hasExplicitSelections = Object.keys(currentSelections).some((nodeId) =>
    Array.isArray(currentSelections[nodeId])
  );

  const derivedSelections = {};
  if (!hasExplicitSelections) {
    (graph.ui.activePath || []).forEach((entry) => {
      if (!edgeIdSet.has(entry)) {
        return;
      }

      const edge = edgeById.get(entry);
      if (!edge) {
        return;
      }

      if (!derivedSelections[edge.from]) {
        derivedSelections[edge.from] = [];
      }

      if (!derivedSelections[edge.from].includes(edge.id)) {
        derivedSelections[edge.from].push(edge.id);
      }
    });
  }

  const sourceSelections = hasExplicitSelections ? currentSelections : derivedSelections;
  const normalizedSelections = {};

  graph.nodes.forEach((node) => {
    const outgoing = outgoingByNode.get(node.id) || [];
    const validEdgeIds = new Set(
      outgoing
        .filter((edge) => typeof edge.to === 'string' && edge.to && nodeById.has(edge.to))
        .map((edge) => edge.id)
    );
    const rawSelection = Array.isArray(sourceSelections[node.id]) ? sourceSelections[node.id] : [];
    const uniqueSelection = [];

    rawSelection.forEach((edgeId) => {
      if (
        typeof edgeId === 'string' &&
        validEdgeIds.has(edgeId) &&
        !uniqueSelection.includes(edgeId)
      ) {
        uniqueSelection.push(edgeId);
      }
    });

    if (node.type === 'xor' && uniqueSelection.length > 1) {
      uniqueSelection.splice(1);
    }

    if (uniqueSelection.length > 0) {
      normalizedSelections[node.id] = uniqueSelection;
    }
  });

  graph.ui.activeSelections = normalizedSelections;
  rebuildActivePathFromSelections(graph);

  if (state.selectedEdgeId && !edgeIdSet.has(state.selectedEdgeId)) {
    setSelectedEdge(null);
  }

  if (state.pendingChoice && !nodeIdSet.has(state.pendingChoice.sourceNodeId)) {
    state.pendingChoice = null;
  }
}

function findNode(nodeId) {
  return state.currentGraph?.nodes.find((node) => node.id === nodeId) || null;
}

function findEdge(edgeId) {
  return state.currentGraph?.edges.find((edge) => edge.id === edgeId) || null;
}

function setSelectedEdge(edgeId, source = null) {
  if (typeof edgeId !== 'string' || edgeId.length === 0) {
    state.selectedEdgeId = null;
    state.selectedEdgeSelectionSource = null;
    return;
  }

  state.selectedEdgeId = edgeId;
  state.selectedEdgeSelectionSource = source;
}

function edgeHasTarget(edge) {
  return Boolean(edge && typeof edge.to === 'string' && edge.to.trim().length > 0);
}

function findButtonForEdge(edge) {
  if (!edge) {
    return null;
  }
  const source = findNode(edge.from);
  return source?.buttons.find((button) => button.id === edge.buttonId) || null;
}

function nodeLabel(nodeId) {
  const node = findNode(nodeId);
  if (!node) {
    return 'Unknown';
  }
  return node.text;
}

function graphPath(graphId) {
  return `${GRAPHS_DIR}/${graphId}.json`;
}

async function ensureGraphsDirectory() {
  const dirExists = await exists(GRAPHS_DIR, { baseDir: BaseDirectory.AppData });
  if (!dirExists) {
    await mkdir(GRAPHS_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
  }

  const base = await appDataDir();
  setStatus(`Graph directory ready: ${base}${GRAPHS_DIR}`);
}

async function refreshGraphList() {
  const warnings = [];
  const summaries = [];

  const entries = await readDir(GRAPHS_DIR, { baseDir: BaseDirectory.AppData });

  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith('.json')) {
      continue;
    }

    const relativePath = `${GRAPHS_DIR}/${entry.name}`;

    try {
      const json = await readTextFile(relativePath, { baseDir: BaseDirectory.AppData });
      const parsed = JSON.parse(json);
      const graph = normalizeGraph(parsed, entry.name);
      const info = await stat(relativePath, { baseDir: BaseDirectory.AppData }).catch(() => null);

      summaries.push({
        id: graph.id,
        name: graph.name,
        path: relativePath,
        updatedAt: graph.updatedAt,
        lastModified:
          graph.updatedAt ||
          (info?.mtime instanceof Date ? info.mtime.toISOString() : graph.createdAt || nowISO())
      });
    } catch (error) {
      warnings.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  summaries.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
  state.graphSummaries = summaries;
  renderGraphList();

  if (warnings.length > 0) {
    const trimmed = warnings.slice(0, 5).join('\n');
    await showAlert(`Some graph files were skipped:\n\n${trimmed}`);
  }
}

function upsertGraphSummary(graph) {
  const summary = {
    id: graph.id,
    name: graph.name,
    path: graphPath(graph.id),
    updatedAt: graph.updatedAt,
    lastModified: graph.updatedAt
  };

  const index = state.graphSummaries.findIndex((item) => item.id === graph.id);
  if (index >= 0) {
    state.graphSummaries[index] = summary;
  } else {
    state.graphSummaries.push(summary);
  }

  state.graphSummaries.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
}

async function loadGraphById(graphId) {
  const summary = state.graphSummaries.find((item) => item.id === graphId);
  if (!summary) {
    return;
  }
  await loadGraphFromSummary(summary);
}

async function loadGraphFromSummary(summary) {
  try {
    const json = await readTextFile(summary.path, { baseDir: BaseDirectory.AppData });
    const parsed = JSON.parse(json);
    const graph = normalizeGraph(parsed, summary.path);

    state.currentGraph = graph;
    setSelectedEdge(null);
    state.pendingChoice = null;
    state.lastChosenEdgeId = null;
    state.lastChosenNodeId = null;
    closeNodeColorPicker();

    if (state.mode === 'view') {
      ensureActivePathSeed();
    }

    renderGraph();
    updateActionButtons();
    setStatus(`Loaded graph: ${graph.name}`);
  } catch (error) {
    console.error('Load failed:', error);
    await showAlert(`Could not load graph file:\n${summary.path}`);
  }
}

async function persistGraph(graph) {
  graph.updatedAt = nowISO();
  await writeTextFile(graphPath(graph.id), JSON.stringify(graph, null, 2), {
    baseDir: BaseDirectory.AppData
  });
}

function scheduleAutosave() {
  if (!state.currentGraph || state.mode !== 'edit') {
    return;
  }

  if (state.autosaveHandle) {
    clearTimeout(state.autosaveHandle);
  }

  state.autosaveHandle = setTimeout(async () => {
    state.autosaveHandle = null;
    if (!state.currentGraph) {
      return;
    }

    try {
      enforceGraphConsistency(state.currentGraph);
      await persistGraph(state.currentGraph);
      upsertGraphSummary(state.currentGraph);
      renderGraphList();
      setStatus('Autosaved.');
    } catch (error) {
      console.error('Autosave failed:', error);
      await showAlert('Autosave failed. Check file permissions.');
    }
  }, AUTOSAVE_DELAY_MS);
}

function renderGraphList() {
  el.graphList.innerHTML = '';

  const currentId = state.currentGraph?.id || null;

  state.graphSummaries.forEach((summary) => {
    const item = document.createElement('li');
    item.className = 'graph-item';

    const button = document.createElement('button');
    button.className = 'graph-item__btn';
    button.type = 'button';
    button.dataset.graphId = summary.id;

    if (summary.id === currentId) {
      button.classList.add('is-selected');
    }

    const name = document.createElement('span');
    name.className = 'graph-item__name';
    name.textContent = summary.name;

    const meta = document.createElement('span');
    meta.className = 'graph-item__meta';
    meta.textContent = formatTimestamp(summary.lastModified);

    button.appendChild(name);
    button.appendChild(meta);
    item.appendChild(button);
    el.graphList.appendChild(item);
  });
}

function renderGraph() {
  const graph = state.currentGraph;

  if (!graph) {
    el.currentGraphName.textContent = 'No Graph Loaded';
    el.nodeLayer.innerHTML = '';
    el.edgeControlLayer.innerHTML = '';
    el.edgeLayer.querySelectorAll('.edge').forEach((node) => node.remove());
    el.emptyState.classList.remove('hidden');
    closeNodeColorPicker();
    applyViewportTransform();
    updateActionButtons();
    return;
  }

  if (state.colorPickerNodeId && !graph.nodes.some((node) => node.id === state.colorPickerNodeId)) {
    closeNodeColorPicker();
  }

  enforceGraphConsistency(graph);

  el.currentGraphName.textContent = graph.name;
  el.emptyState.classList.toggle('hidden', graph.nodes.length > 0);

  renderNodes();
  renderEdges();
  applyViewportTransform();
  renderGraphList();
  updateActionButtons();
}

function getPathContext() {
  const graph = state.currentGraph;
  const context = {
    nodePathSet: new Set(),
    edgePathSet: new Set(),
    selectedEdgeSet: new Set(),
    selectedNodeSet: new Set(),
    activeNodeId: null,
    activeEdgeId: null
  };

  if (!graph) {
    return context;
  }

  const nodeIdSet = new Set(graph.nodes.map((node) => node.id));
  const edgeIdSet = new Set(graph.edges.map((edge) => edge.id));
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const normalizedPath = [];

  (graph.ui.activePath || []).forEach((entry) => {
    if (nodeIdSet.has(entry) || edgeIdSet.has(entry)) {
      normalizedPath.push(entry);
    }
  });

  graph.ui.activePath = normalizedPath;

  normalizedPath.forEach((entry) => {
    if (nodeIdSet.has(entry)) {
      context.nodePathSet.add(entry);
    }
    if (edgeIdSet.has(entry)) {
      context.edgePathSet.add(entry);
    }
  });

  const selections = getActiveSelections(graph);
  Object.values(selections).forEach((selection) => {
    if (!Array.isArray(selection)) {
      return;
    }

    selection.forEach((edgeId) => {
      if (typeof edgeId === 'string' && edgeIdSet.has(edgeId)) {
        const edge = edgeById.get(edgeId);
        if (edge && edgeHasTarget(edge)) {
          context.selectedEdgeSet.add(edgeId);
          context.selectedNodeSet.add(edge.from);
          context.selectedNodeSet.add(edge.to);
        }
      }
    });
  });

  if (state.lastChosenEdgeId && context.edgePathSet.has(state.lastChosenEdgeId)) {
    context.activeEdgeId = state.lastChosenEdgeId;
    const chosenEdge = edgeById.get(state.lastChosenEdgeId);
    if (chosenEdge && context.nodePathSet.has(chosenEdge.to)) {
      context.activeNodeId = chosenEdge.to;
    }
  }

  if (!context.activeNodeId && state.lastChosenNodeId && context.nodePathSet.has(state.lastChosenNodeId)) {
    context.activeNodeId = state.lastChosenNodeId;
  }

  for (let index = normalizedPath.length - 1; index >= 0; index -= 1) {
    const entry = normalizedPath[index];
    if (!context.activeEdgeId && edgeIdSet.has(entry)) {
      context.activeEdgeId = entry;
    }
    if (!context.activeNodeId && nodeIdSet.has(entry)) {
      context.activeNodeId = entry;
    }
    if (context.activeEdgeId && context.activeNodeId) {
      break;
    }
  }

  return context;
}

function renderNodes() {
  const graph = state.currentGraph;
  if (!graph) {
    return;
  }

  el.nodeLayer.innerHTML = '';
  state.nodeElements.clear();

  const context = getPathContext();
  const showViewPath = state.mode === 'view';
  graph.nodes.forEach((node) => {
    const nodeEl = document.createElement('div');
    nodeEl.className = 'node';
    nodeEl.dataset.nodeId = node.id;
    nodeEl.style.left = `${node.x}px`;
    nodeEl.style.top = `${node.y}px`;
    const nodeColor = getNodeBaseColor(node);
    const nodeTextColor = getReadableTextColor(nodeColor);
    const titleColor =
      nodeTextColor === '#ffffff' ? mixColor(nodeColor, 0.2) : mixColor(nodeColor, -0.12);
    nodeEl.style.setProperty('--node-color', nodeColor);
    nodeEl.style.setProperty('--node-title-color', titleColor);
    nodeEl.style.setProperty('--node-text-color', nodeTextColor);

    if (graph.ui.selectedNodeId === node.id) {
      nodeEl.classList.add('node--selected');
    }

    if (showViewPath && context.nodePathSet.has(node.id)) {
      nodeEl.classList.add('node--path');
    }

    if (context.selectedNodeSet.has(node.id) || (showViewPath && context.activeNodeId === node.id)) {
      nodeEl.classList.add('node--active');
    }

    if (showViewPath && context.activeNodeId === node.id) {
      nodeEl.classList.add('node--active-current');
    }

    if (state.pendingChoice?.sourceNodeId === node.id) {
      nodeEl.classList.add('node--choice-source');
    }

    const header = document.createElement('div');
    header.className = 'node__header';

    const title = document.createElement('div');
    title.className = 'node__title';
    title.dataset.nodeId = node.id;
    title.textContent = node.text;

    const typeToggle =
      state.mode === 'edit' ? document.createElement('button') : document.createElement('span');
    typeToggle.className =
      state.mode === 'edit'
        ? `win-button node-type-toggle node-type-toggle--${node.type}`
        : `node-type-badge node-type-toggle--${node.type}`;
    typeToggle.dataset.nodeId = node.id;
    typeToggle.textContent = node.type.toUpperCase();

    if (state.mode === 'edit') {
      typeToggle.type = 'button';
      typeToggle.title = 'Klick: Node-Typ OR/XOR umschalten';
    }

    header.appendChild(title);
    header.appendChild(typeToggle);

    nodeEl.appendChild(header);
    el.nodeLayer.appendChild(nodeEl);
    state.nodeElements.set(node.id, nodeEl);
  });
}

function cubicBezierPoint(t, p0, p1, p2, p3) {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;

  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y
  };
}

function getDanglingEdgePoint(graph, sourceNode, edge) {
  if (Number.isFinite(edge.pendingX) && Number.isFinite(edge.pendingY)) {
    return { x: edge.pendingX, y: edge.pendingY };
  }

  const outgoingEdges = graph.edges.filter((item) => item.from === sourceNode.id);
  const index = Math.max(0, outgoingEdges.findIndex((item) => item.id === edge.id));
  const horizontalStep = 250;
  const verticalStep = 90;
  const verticalOffset =
    index === 0 ? 0 : (index % 2 === 1 ? 1 : -1) * Math.ceil(index / 2) * verticalStep;

  return {
    x: sourceNode.x + horizontalStep,
    y: sourceNode.y + 18 + verticalOffset
  };
}

function renderEdges() {
  const graph = state.currentGraph;
  if (!graph) {
    return;
  }

  const context = getPathContext();
  const showViewPath = state.mode === 'view';

  el.edgeControlLayer.innerHTML = '';
  el.edgeLayer.querySelectorAll('.edge').forEach((node) => node.remove());

  graph.edges.forEach((edge) => {
    const sourceNode = findNode(edge.from);
    const sourceEl = state.nodeElements.get(edge.from);
    if (!sourceNode || !sourceEl) {
      return;
    }

    const targetNode = edgeHasTarget(edge) ? findNode(edge.to) : null;
    const targetEl = targetNode ? state.nodeElements.get(targetNode.id) : null;
    const isDangling = !targetNode || !targetEl;

    if (isDangling && state.mode !== 'edit') {
      return;
    }

    const sourceWidth = sourceEl.offsetWidth || NODE_WIDTH;
    const sourceHeight = sourceEl.offsetHeight || 80;
    const sourceCenterX = sourceNode.x + sourceWidth / 2;
    const sourceCenterY = sourceNode.y + sourceHeight / 2;

    let endX = 0;
    let endY = 0;

    if (isDangling) {
      const danglingPoint = getDanglingEdgePoint(graph, sourceNode, edge);
      endX = danglingPoint.x;
      endY = danglingPoint.y;
    } else {
      const targetWidth = targetEl.offsetWidth || NODE_WIDTH;
      const targetCenterX = targetNode.x + targetWidth / 2;
      const targetTopY = targetNode.y + 1;
      endX = targetCenterX;
      endY = targetTopY;
    }

    const startFromBottom = endY >= sourceCenterY;
    const startX = sourceCenterX;
    const startY = startFromBottom ? sourceNode.y + sourceHeight : sourceNode.y;

    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const verticalBend = Math.max(54, Math.abs(deltaY) * 0.5);
    const horizontalBend = deltaX * 0.35;
    const c1x = startX + horizontalBend;
    const c1y = startY + (startFromBottom ? verticalBend : -verticalBend);
    const c2x = endX;
    const c2y = endY - verticalBend;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.classList.add('edge');
    path.dataset.edgeId = edge.id;
    path.setAttribute('d', `M ${startX} ${startY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${endX} ${endY}`);
    let danglingHitTarget = null;

    if (showViewPath && context.edgePathSet.has(edge.id)) {
      path.classList.add('edge--path');
    }

    if (isDangling) {
      path.classList.add('edge--dangling');
      danglingHitTarget = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      danglingHitTarget.classList.add('edge-dangling-hit');
      danglingHitTarget.dataset.edgeId = edge.id;
      danglingHitTarget.setAttribute('cx', `${endX}`);
      danglingHitTarget.setAttribute('cy', `${endY}`);
      danglingHitTarget.setAttribute('r', '14');
    }

    const isEditSelected = state.mode === 'edit' && state.selectedEdgeId === edge.id;
    const isLineSelected = isEditSelected && state.selectedEdgeSelectionSource === 'line';
    const isSelectionActive = context.selectedEdgeSet.has(edge.id);
    const isViewActive = showViewPath && context.activeEdgeId === edge.id;

    const isStronglyActive = isSelectionActive || isViewActive;
    const isPath = showViewPath && context.edgePathSet.has(edge.id);

    if (isStronglyActive) {
      path.classList.add('edge--active');
    }

    if (isLineSelected && !isStronglyActive) {
      path.classList.add('edge--line-selected');
    }

    const markerVariant = isStronglyActive ? 'active' : isPath ? 'path' : 'default';
    path.setAttribute('marker-start', `url(#edge-start-${markerVariant})`);
    path.setAttribute('marker-end', `url(#arrow-head-${markerVariant})`);

    const button = findButtonForEdge(edge);
    const edgeButton = document.createElement('button');
    edgeButton.className = 'win-button edge-choice-button';
    edgeButton.type = 'button';
    edgeButton.dataset.edgeId = edge.id;
    edgeButton.textContent = button?.text || 'Choice';
    edgeButton.title = `${button?.text || 'Choice'}: ${nodeLabel(edge.from)} -> ${
      edgeHasTarget(edge) ? nodeLabel(edge.to) : '(unassigned)'
    }`;

    if (isStronglyActive) {
      edgeButton.classList.add('is-selected');
    }

    const midpoint = cubicBezierPoint(
      0.5,
      { x: startX, y: startY },
      { x: c1x, y: c1y },
      { x: c2x, y: c2y },
      { x: endX, y: endY }
    );
    const indicatorPoint = cubicBezierPoint(
      0.62,
      { x: startX, y: startY },
      { x: c1x, y: c1y },
      { x: c2x, y: c2y },
      { x: endX, y: endY }
    );
    edgeButton.style.left = `${Math.round(midpoint.x)}px`;
    edgeButton.style.top = `${Math.round(midpoint.y - 12)}px`;

    el.edgeLayer.appendChild(path);
    if (danglingHitTarget) {
      el.edgeLayer.appendChild(danglingHitTarget);
    }
    el.edgeControlLayer.appendChild(edgeButton);

    if (isStronglyActive) {
      const activeIndicator = document.createElement('div');
      activeIndicator.className = 'edge-activity-indicator';
      activeIndicator.style.left = `${Math.round(indicatorPoint.x)}px`;
      activeIndicator.style.top = `${Math.round(indicatorPoint.y)}px`;
      activeIndicator.title = 'Active choice';
      el.edgeControlLayer.appendChild(activeIndicator);
    }
  });
}

function updateActionButtons() {
  const graph = state.currentGraph;
  const selectedNode = graph?.ui.selectedNodeId || null;
  const selectedEdge = state.selectedEdgeId;
  const edgeIdSet = new Set((graph?.edges || []).map((edge) => edge.id));
  const hasActiveEdges = Array.isArray(graph?.ui?.activePath)
    ? graph.ui.activePath.some((entry) => edgeIdSet.has(entry))
    : false;

  const hasGraph = Boolean(graph);
  const inEdit = state.mode === 'edit';

  el.renameGraphBtn.disabled = !hasGraph;
  el.duplicateGraphBtn.disabled = !hasGraph;
  el.deleteGraphBtn.disabled = !hasGraph;
  el.exportGraphBtn.disabled = !hasGraph;

  el.addNodeBtn.disabled = !hasGraph || !inEdit;
  el.addChoiceBtn.disabled = !hasGraph || !inEdit;
  el.editNodeBtn.disabled = !hasGraph || !inEdit || !selectedNode;
  el.nodeColorBtn.disabled = !hasGraph || !inEdit || !selectedNode;
  el.editChoiceBtn.disabled = !hasGraph || !inEdit || !selectedEdge;
  el.deleteNodeBtn.disabled = !hasGraph || !inEdit || !selectedNode;
  el.deleteChoiceBtn.disabled = !hasGraph || !inEdit || !selectedEdge;

  el.clearPathBtn.disabled = !hasGraph || !hasActiveEdges;
}

function getCanvasPoint(event) {
  const rect = el.editorSurface.getBoundingClientRect();
  const zoom = currentZoom();
  return {
    x: (event.clientX - rect.left - state.viewportOffset.x) / zoom,
    y: (event.clientY - rect.top - state.viewportOffset.y) / zoom
  };
}

function getDefaultNodePosition() {
  const graph = state.currentGraph;
  const width = el.editorSurface.clientWidth || 900;
  const height = el.editorSurface.clientHeight || 600;
  const zoom = currentZoom();
  const index = graph ? graph.nodes.length : 0;
  const offset = (index % 6) * 18;
  const centerX = (width / 2 - state.viewportOffset.x) / zoom;
  const centerY = (height / 2 - state.viewportOffset.y) / zoom;

  return {
    x: Math.floor(centerX - NODE_WIDTH / 2 + offset),
    y: Math.floor(centerY - 44 + offset)
  };
}

function handleEditorBackgroundClick(event) {
  if (state.suppressBackgroundClickOnce) {
    state.suppressBackgroundClickOnce = false;
    return;
  }

  if (!state.currentGraph || state.mode !== 'edit') {
    return;
  }

  if (event.target.closest('.node') || event.target.closest('[data-edge-id]')) {
    return;
  }

  if (state.pendingChoice) {
    return;
  }

  state.currentGraph.ui.selectedNodeId = null;
  setSelectedEdge(null);
  renderGraph();
  setStatus('Selection cleared.');
}

function handleEditorSurfaceMouseDown(event) {
  if (event.button !== 0) {
    return;
  }

  if (state.dragging) {
    return;
  }

  if (event.target.closest('.zoom-control')) {
    return;
  }

  if (event.target.closest('.node') || event.target.closest('[data-edge-id]')) {
    return;
  }

  state.panning = {
    startClientX: event.clientX,
    startClientY: event.clientY,
    startOffsetX: state.viewportOffset.x,
    startOffsetY: state.viewportOffset.y,
    moved: false
  };

  el.editorSurface.classList.add('is-panning');
  event.preventDefault();
}

function handleEditorDoubleClick(event) {
  if (!state.currentGraph || state.mode !== 'edit') {
    return;
  }

  if (event.target.closest('.node') || event.target.closest('[data-edge-id]')) {
    return;
  }

  const point = getCanvasPoint(event);
  addNodeAt(point.x - NODE_WIDTH / 2, point.y - 30);
}

function handleNodeLayerClick(event) {
  if (!state.currentGraph) {
    return;
  }

  const typeToggle = event.target.closest('.node-type-toggle');
  if (typeToggle) {
    const nodeId = typeToggle.dataset.nodeId;
    if (nodeId && state.mode === 'edit') {
      toggleNodeType(nodeId);
    }
    event.stopPropagation();
    return;
  }

  const nodeElement = event.target.closest('.node');
  if (!nodeElement) {
    return;
  }

  const nodeId = nodeElement.dataset.nodeId;
  if (!nodeId) {
    return;
  }

  if (state.mode === 'edit' && state.pendingChoice) {
    completePendingChoice(nodeId);
    event.stopPropagation();
    return;
  }

  state.currentGraph.ui.selectedNodeId = nodeId;
  setSelectedEdge(null);
  renderGraph();
  setStatus('Node selected.');

  event.stopPropagation();
}

function handleNodeLayerDoubleClick(event) {
  if (!state.currentGraph || state.mode !== 'edit') {
    return;
  }

  const title = event.target.closest('.node__title');
  if (title) {
    const nodeId = title.dataset.nodeId;
    if (nodeId) {
      state.currentGraph.ui.selectedNodeId = nodeId;
      setSelectedEdge(null);
      void editSelectedNodeTextFlow();
    }
    event.stopPropagation();
  }
}

function handleNodeLayerMouseDown(event) {
  if (!state.currentGraph || state.mode !== 'edit') {
    return;
  }

  if (event.button !== 0) {
    return;
  }

  if (event.target.closest('.node-type-toggle')) {
    return;
  }

  const nodeElement = event.target.closest('.node');
  if (!nodeElement) {
    return;
  }

  const nodeId = nodeElement.dataset.nodeId;
  if (!nodeId) {
    return;
  }

  const node = findNode(nodeId);
  if (!node) {
    return;
  }

  const pointerWorld = getCanvasPoint(event);
  state.dragging = {
    nodeId,
    offsetX: pointerWorld.x - node.x,
    offsetY: pointerWorld.y - node.y,
    moved: false
  };

  state.currentGraph.ui.selectedNodeId = nodeId;
  setSelectedEdge(null);
  renderGraph();

  event.preventDefault();
}

function handleWindowMouseMove(event) {
  if (state.edgeConnectDrag && state.currentGraph) {
    const edge = findEdge(state.edgeConnectDrag.edgeId);
    if (!edge || edgeHasTarget(edge)) {
      return;
    }

    const point = getCanvasPoint(event);
    const nextPendingX = Math.round(point.x);
    const nextPendingY = Math.round(point.y);

    if (edge.pendingX === nextPendingX && edge.pendingY === nextPendingY) {
      return;
    }

    edge.pendingX = nextPendingX;
    edge.pendingY = nextPendingY;
    state.edgeConnectDrag.moved = true;
    renderEdges();
    applyViewportTransform();
    return;
  }

  if (state.dragging && state.currentGraph) {
    const node = findNode(state.dragging.nodeId);
    const nodeElement = state.nodeElements.get(state.dragging.nodeId);
    if (!node || !nodeElement) {
      return;
    }

    const canvasRect = el.editorSurface.getBoundingClientRect();
    const zoom = currentZoom();
    const pointerWorldX = (event.clientX - canvasRect.left - state.viewportOffset.x) / zoom;
    const pointerWorldY = (event.clientY - canvasRect.top - state.viewportOffset.y) / zoom;
    const nextX = pointerWorldX - state.dragging.offsetX;
    const nextY = pointerWorldY - state.dragging.offsetY;

    if (Math.round(nextX) === node.x && Math.round(nextY) === node.y) {
      return;
    }

    node.x = Math.round(nextX);
    node.y = Math.round(nextY);
    state.dragging.moved = true;

    nodeElement.style.left = `${node.x}px`;
    nodeElement.style.top = `${node.y}px`;

    renderEdges();
    applyViewportTransform();
    return;
  }

  if (!state.panning) {
    return;
  }

  const nextOffsetX = state.panning.startOffsetX + (event.clientX - state.panning.startClientX);
  const nextOffsetY = state.panning.startOffsetY + (event.clientY - state.panning.startClientY);

  if (nextOffsetX === state.viewportOffset.x && nextOffsetY === state.viewportOffset.y) {
    return;
  }

  state.viewportOffset.x = nextOffsetX;
  state.viewportOffset.y = nextOffsetY;
  state.panning.moved = true;
  applyViewportTransform();
}

function handleWindowMouseUp(event) {
  if (!state.dragging && !state.panning && !state.edgeConnectDrag) {
    return;
  }

  if (state.edgeConnectDrag && state.currentGraph) {
    const dragState = state.edgeConnectDrag;
    state.edgeConnectDrag = null;

    const edge = findEdge(dragState.edgeId);
    if (edge && !edgeHasTarget(edge)) {
      const targetNodeElement = event.target?.closest?.('.node');
      const targetNodeId = targetNodeElement?.dataset?.nodeId || null;

      if (targetNodeId && targetNodeId !== dragState.sourceNodeId) {
        if (assignDanglingChoiceToNode(dragState.edgeId, targetNodeId)) {
          return;
        }
      }

      if (targetNodeId === dragState.sourceNodeId) {
        edge.pendingX = dragState.startPendingX;
        edge.pendingY = dragState.startPendingY;
        renderEdges();
        applyViewportTransform();
        setStatus('Eine Choice kann nicht mit ihrem eigenen Source-Node verbunden werden.');
      } else if (dragState.moved) {
        setStatus('Keine Verbindung gesetzt. Dreieck auf einem Ziel-Node loslassen.');
      }
    }
  }

  if (state.dragging) {
    const moved = state.dragging.moved;
    state.dragging = null;

    if (moved) {
      scheduleAutosave();
      setStatus('Node moved.');
    }
  }

  if (state.panning) {
    const moved = state.panning.moved;
    state.panning = null;
    el.editorSurface.classList.remove('is-panning');

    if (moved) {
      state.suppressBackgroundClickOnce = true;
      setStatus('Canvas moved.');
    }
  }
}

function applyViewportTransform() {
  const zoom = currentZoom();
  const x = Math.round(state.viewportOffset.x * 100) / 100;
  const y = Math.round(state.viewportOffset.y * 100) / 100;
  const transform = `translate(${x}px, ${y}px) scale(${zoom})`;

  el.edgeLayer.style.transform = transform;
  el.edgeControlLayer.style.transform = transform;
  el.nodeLayer.style.transform = transform;
}

function handleEdgeLayerMouseDown(event) {
  if (!state.currentGraph || state.mode !== 'edit') {
    return;
  }

  if (event.button !== 0) {
    return;
  }

  const handle = event.target.closest('.edge-dangling-hit');
  if (!handle) {
    return;
  }

  const edgeId = handle.dataset.edgeId;
  if (!edgeId) {
    return;
  }

  const edge = findEdge(edgeId);
  if (!edge || edgeHasTarget(edge)) {
    return;
  }

  const sourceNode = findNode(edge.from);
  if (!sourceNode) {
    return;
  }

  const startPoint = getDanglingEdgePoint(state.currentGraph, sourceNode, edge);
  state.edgeConnectDrag = {
    edgeId,
    sourceNodeId: edge.from,
    startPendingX: startPoint.x,
    startPendingY: startPoint.y,
    moved: false
  };

  setSelectedEdge(edgeId, 'line');
  state.currentGraph.ui.selectedNodeId = null;
  renderGraph();
  setStatus('Dreieck ziehen und auf einem Node loslassen, um zu verbinden.');

  event.preventDefault();
  event.stopPropagation();
}

function handleEdgeLayerClick(event) {
  if (!state.currentGraph || state.mode !== 'edit') {
    return;
  }

  const target = event.target.closest('[data-edge-id]');
  if (!target) {
    return;
  }

  const edgeId = target.dataset.edgeId;
  if (!edgeId) {
    return;
  }

  const edge = findEdge(edgeId);
  if (edge && !edgeHasTarget(edge)) {
    setSelectedEdge(edgeId, 'line');
    state.currentGraph.ui.selectedNodeId = null;
    renderGraph();
    setStatus('Dreieck ziehen und auf einem Node loslassen, um zu verbinden.');
    event.stopPropagation();
    return;
  }

  setSelectedEdge(edgeId, 'line');
  state.currentGraph.ui.selectedNodeId = null;
  renderGraph();
  setStatus('Kante ausgewählt (Linie).');
  event.stopPropagation();
}

function handleEdgeLayerDoubleClick(event) {
  if (!state.currentGraph || state.mode !== 'edit') {
    return;
  }

  const target = event.target.closest('[data-edge-id]');
  if (!target) {
    return;
  }

  const edgeId = target.dataset.edgeId;
  if (!edgeId) {
    return;
  }

  setSelectedEdge(edgeId, 'line');
  void editSelectedChoiceTextFlow();
  event.stopPropagation();
}

function handleEdgeControlLayerClick(event) {
  if (!state.currentGraph) {
    return;
  }

  const target = event.target.closest('.edge-choice-button');
  if (!target) {
    return;
  }

  const edgeId = target.dataset.edgeId;
  if (!edgeId) {
    return;
  }

  if (state.mode === 'edit') {
    const edge = findEdge(edgeId);
    if (edge && !edgeHasTarget(edge)) {
      setSelectedEdge(edgeId, 'button');
      state.currentGraph.ui.selectedNodeId = null;
      renderGraph();
      setStatus('Dreieck ziehen und auf einem Node loslassen, um zu verbinden.');
      event.stopPropagation();
      return;
    }

    const selection = applyTypedEdgeSelection(edgeId);
    setSelectedEdge(selection?.edgeIsSelected ? edgeId : null, selection?.edgeIsSelected ? 'button' : null);
    state.currentGraph.ui.selectedNodeId = null;
    renderGraph();
    if (selection) {
      const verb = selection.edgeIsSelected ? 'Gewählt' : 'Abgewählt';
      setStatus(`${verb} (${selection.sourceNodeType.toUpperCase()}): ${findButtonForEdge(selection.edge)?.text || 'Choice'}`);
    } else {
      setStatus('Choice selected.');
    }
  } else {
    followChoice(edgeId);
  }

  event.stopPropagation();
}

function handleEdgeControlLayerDoubleClick(event) {
  if (!state.currentGraph || state.mode !== 'edit') {
    return;
  }

  const target = event.target.closest('.edge-choice-button');
  if (!target) {
    return;
  }

  const edgeId = target.dataset.edgeId;
  if (!edgeId) {
    return;
  }

  setSelectedEdge(edgeId, 'button');
  void editSelectedChoiceTextFlow();
  event.stopPropagation();
}

function addNodeAt(x, y) {
  const graph = state.currentGraph;
  if (!graph) {
    return null;
  }

  const node = {
    id: uid('n'),
    x: Math.round(x),
    y: Math.round(y),
    text: 'New Node',
    type: DEFAULT_NODE_TYPE,
    color: null,
    buttons: []
  };

  graph.nodes.push(node);
  graph.ui.selectedNodeId = node.id;
  setSelectedEdge(null);

  renderGraph();
  scheduleAutosave();
  setStatus('Node added.');

  if (state.pendingChoice) {
    completePendingChoice(node.id);
  }

  return node;
}

function toggleNodeType(nodeId) {
  if (!state.currentGraph || state.mode !== 'edit') {
    return;
  }

  const node = findNode(nodeId);
  if (!node) {
    return;
  }

  node.type = node.type === 'xor' ? 'or' : 'xor';

  const selections = getActiveSelections(state.currentGraph);
  if (node.type === 'xor' && Array.isArray(selections[node.id]) && selections[node.id].length > 1) {
    selections[node.id] = selections[node.id].slice(0, 1);
  }

  rebuildActivePathFromSelections(state.currentGraph);

  if (state.lastChosenEdgeId && !state.currentGraph.ui.activePath.includes(state.lastChosenEdgeId)) {
    state.lastChosenEdgeId = null;
  }
  if (state.lastChosenNodeId && !state.currentGraph.ui.activePath.includes(state.lastChosenNodeId)) {
    state.lastChosenNodeId = null;
  }

  renderGraph();
  scheduleAutosave();
  setStatus(`Node-Typ auf ${node.type.toUpperCase()} gesetzt.`);
}

function addNodeAtDefaultPosition() {
  if (!state.currentGraph || state.mode !== 'edit') {
    return;
  }

  const point = getDefaultNodePosition();
  addNodeAt(point.x, point.y);
}

async function editSelectedNodeTextFlow() {
  if (!state.currentGraph || state.mode !== 'edit') {
    return;
  }

  const node = findNode(state.currentGraph.ui.selectedNodeId);
  if (!node) {
    await showAlert('Select a node first.');
    return;
  }

  const value = await showPrompt({
    title: 'Edit Node',
    message: 'Node text:',
    defaultValue: node.text,
    okText: 'Apply'
  });

  if (value === null) {
    return;
  }

  node.text = value.trim() || 'Untitled Node';
  renderGraph();
  scheduleAutosave();
  setStatus('Node text updated.');
}

async function addChoiceFlow() {
  if (!state.currentGraph || state.mode !== 'edit') {
    return;
  }

  const sourceId = state.currentGraph.ui.selectedNodeId;
  if (!sourceId) {
    await showAlert('Select a source node first.');
    return;
  }

  const label = await showPrompt({
    title: 'Add Choice',
    message: 'Button text:',
    defaultValue: 'Option',
    okText: 'Create'
  });

  if (label === null) {
    return;
  }

  createChoiceWithNewChildNode(sourceId, label.trim() || 'Choice');
}

function createChoiceWithNewChildNode(sourceNodeId, buttonText) {
  if (!state.currentGraph) {
    return;
  }

  const sourceNode = findNode(sourceNodeId);
  if (!sourceNode) {
    return;
  }

  const outgoingCount = state.currentGraph.edges.filter((edge) => edge.from === sourceNodeId).length;
  const horizontalStep = 250;
  const verticalStep = 90;

  let offsetY = 0;
  if (outgoingCount > 0) {
    const magnitude = Math.ceil(outgoingCount / 2) * verticalStep;
    const sign = outgoingCount % 2 === 1 ? 1 : -1;
    offsetY = sign * magnitude;
  }

  const pendingX = Math.round(sourceNode.x + horizontalStep);
  const pendingY = Math.round(sourceNode.y + 18 + offsetY);

  const buttonId = uid('b');
  const edgeId = uid('e');

  sourceNode.buttons.push({
    id: buttonId,
    text: buttonText,
    to: null
  });

  state.currentGraph.edges.push({
    id: edgeId,
    from: sourceNode.id,
    to: null,
    buttonId,
    pendingX,
    pendingY
  });

  state.pendingChoice = null;
  state.currentGraph.ui.selectedNodeId = null;
  setSelectedEdge(edgeId);

  enforceGraphConsistency(state.currentGraph);
  renderGraph();
  scheduleAutosave();
  setStatus('Choice erstellt. Ziehe das Dreieck auf einen Ziel-Node, um zu verbinden.');
}

function assignDanglingChoiceToNode(edgeId, targetNodeId) {
  if (!state.currentGraph || state.mode !== 'edit') {
    return false;
  }

  const edge = findEdge(edgeId);
  const targetNode = findNode(targetNodeId);
  const sourceNode = edge ? findNode(edge.from) : null;
  if (!edge || edgeHasTarget(edge) || !targetNode || !sourceNode) {
    return false;
  }

  if (sourceNode.id === targetNode.id) {
    return false;
  }

  edge.to = targetNode.id;
  edge.pendingX = null;
  edge.pendingY = null;

  const button = findButtonForEdge(edge);
  if (button) {
    button.to = targetNode.id;
  }

  state.currentGraph.ui.selectedNodeId = targetNode.id;
  setSelectedEdge(null);

  enforceGraphConsistency(state.currentGraph);
  renderGraph();
  scheduleAutosave();
  setStatus('Choice mit Node verbunden.');
  return true;
}

function completePendingChoice(targetNodeId) {
  if (!state.currentGraph || !state.pendingChoice) {
    return;
  }

  const { sourceNodeId, buttonText } = state.pendingChoice;
  const sourceNode = findNode(sourceNodeId);
  const targetNode = findNode(targetNodeId);

  if (!sourceNode || !targetNode) {
    state.pendingChoice = null;
    renderGraph();
    return;
  }

  const buttonId = uid('b');
  const edgeId = uid('e');

  sourceNode.buttons.push({
    id: buttonId,
    text: buttonText,
    to: targetNode.id
  });

  state.currentGraph.edges.push({
    id: edgeId,
    from: sourceNode.id,
    to: targetNode.id,
    buttonId
  });

  state.pendingChoice = null;
  setSelectedEdge(edgeId);
  state.currentGraph.ui.selectedNodeId = null;

  enforceGraphConsistency(state.currentGraph);
  renderGraph();
  scheduleAutosave();
  setStatus('Choice created.');
}

async function editSelectedChoiceTextFlow() {
  if (!state.currentGraph || state.mode !== 'edit') {
    return;
  }

  const edge = findEdge(state.selectedEdgeId);
  const button = findButtonForEdge(edge);

  if (!edge || !button) {
    await showAlert('Select a choice first.');
    return;
  }

  const value = await showPrompt({
    title: 'Edit Choice',
    message: 'Choice text:',
    defaultValue: button.text,
    okText: 'Apply'
  });

  if (value === null) {
    return;
  }

  button.text = value.trim() || 'Choice';
  renderGraph();
  scheduleAutosave();
  setStatus('Choice text updated.');
}

async function deleteSelectedNodeFlow() {
  if (!state.currentGraph || state.mode !== 'edit') {
    return;
  }

  const nodeId = state.currentGraph.ui.selectedNodeId;
  if (!nodeId) {
    await showAlert('Select a node to delete.');
    return;
  }

  const node = findNode(nodeId);
  if (!node) {
    return;
  }

  const yes = await confirm(`Delete node "${node.text}" and all connected choices?`, {
    title: 'Delete Node',
    kind: 'warning'
  });

  if (!yes) {
    return;
  }

  const edgesToDelete = state.currentGraph.edges.filter(
    (edge) => edge.from === nodeId || edge.to === nodeId
  );

  edgesToDelete.forEach((edge) => {
    const source = findNode(edge.from);
    if (source) {
      source.buttons = source.buttons.filter((button) => button.id !== edge.buttonId);
    }
  });

  state.currentGraph.edges = state.currentGraph.edges.filter(
    (edge) => edge.from !== nodeId && edge.to !== nodeId
  );

  state.currentGraph.nodes = state.currentGraph.nodes.filter((item) => item.id !== nodeId);

  state.currentGraph.ui.selectedNodeId = null;
  setSelectedEdge(null);

  enforceGraphConsistency(state.currentGraph);
  renderGraph();
  scheduleAutosave();
  setStatus('Node deleted.');
}

async function deleteSelectedChoiceFlow() {
  if (!state.currentGraph || state.mode !== 'edit') {
    return;
  }

  const edge = findEdge(state.selectedEdgeId);
  if (!edge) {
    await showAlert('Select a choice to delete.');
    return;
  }

  const button = findButtonForEdge(edge);
  const label = button?.text || 'this choice';

  const yes = await confirm(`Delete choice "${label}"?`, {
    title: 'Delete Choice',
    kind: 'warning'
  });

  if (!yes) {
    return;
  }

  const source = findNode(edge.from);
  if (source) {
    source.buttons = source.buttons.filter((item) => item.id !== edge.buttonId);
  }

  state.currentGraph.edges = state.currentGraph.edges.filter((item) => item.id !== edge.id);
  setSelectedEdge(null);

  enforceGraphConsistency(state.currentGraph);
  renderGraph();
  scheduleAutosave();
  setStatus('Choice deleted.');
}

function ensureActivePathSeed() {
  if (!state.currentGraph) {
    return;
  }

  getActiveSelections(state.currentGraph);
  rebuildActivePathFromSelections(state.currentGraph);

  if (state.currentGraph.ui.activePath.length === 0 && state.currentGraph.nodes.length > 0) {
    state.currentGraph.ui.activePath = [state.currentGraph.nodes[0].id];
  }

  if (
    state.lastChosenEdgeId &&
    !state.currentGraph.ui.activePath.includes(state.lastChosenEdgeId)
  ) {
    state.lastChosenEdgeId = null;
  }

  if (
    state.lastChosenNodeId &&
    !state.currentGraph.ui.activePath.includes(state.lastChosenNodeId)
  ) {
    state.lastChosenNodeId = null;
  }
}

function applyTypedEdgeSelection(edgeId) {
  if (!state.currentGraph) {
    return null;
  }

  const edge = findEdge(edgeId);
  if (!edge || !edgeHasTarget(edge)) {
    return null;
  }

  const sourceNode = findNode(edge.from);
  if (!sourceNode) {
    return null;
  }

  const sourceNodeType = normalizeNodeType(sourceNode.type);
  const selections = getActiveSelections(state.currentGraph);
  const currentSelection = Array.isArray(selections[sourceNode.id])
    ? Array.from(
        new Set(selections[sourceNode.id].filter((id) => typeof id === 'string' && id.length > 0))
      )
    : [];
  let edgeIsSelected = true;

  if (sourceNodeType === 'or') {
    if (currentSelection.includes(edge.id)) {
      const nextSelection = currentSelection.filter((id) => id !== edge.id);
      if (nextSelection.length > 0) {
        selections[sourceNode.id] = nextSelection;
      } else {
        delete selections[sourceNode.id];
      }
      edgeIsSelected = false;
    } else {
      currentSelection.push(edge.id);
      selections[sourceNode.id] = currentSelection;
      edgeIsSelected = true;
    }
  } else {
    if (currentSelection.length === 1 && currentSelection[0] === edge.id) {
      delete selections[sourceNode.id];
      edgeIsSelected = false;
    } else {
      selections[sourceNode.id] = [edge.id];
      edgeIsSelected = true;
    }
  }

  rebuildActivePathFromSelections(state.currentGraph);
  if (edgeIsSelected) {
    state.lastChosenEdgeId = edge.id;
    state.lastChosenNodeId = edge.to;
  } else {
    if (state.lastChosenEdgeId === edge.id) {
      state.lastChosenEdgeId = null;
    }
    if (state.lastChosenNodeId === edge.to) {
      state.lastChosenNodeId = null;
    }
  }

  if (
    state.lastChosenEdgeId &&
    !state.currentGraph.ui.activePath.includes(state.lastChosenEdgeId)
  ) {
    state.lastChosenEdgeId = null;
  }
  if (
    state.lastChosenNodeId &&
    !state.currentGraph.ui.activePath.includes(state.lastChosenNodeId)
  ) {
    state.lastChosenNodeId = null;
  }

  return { edge, sourceNodeType, edgeIsSelected };
}

function followChoice(edgeId) {
  if (!state.currentGraph || state.mode !== 'view') {
    return;
  }

  const selection = applyTypedEdgeSelection(edgeId);
  if (!selection) {
    return;
  }

  renderGraph();

  const button = findButtonForEdge(selection.edge);
  const label = button ? button.text : 'Choice';
  if (selection.edgeIsSelected) {
    setStatus(`Gewählt (${selection.sourceNodeType.toUpperCase()}): ${label}`);
  } else {
    setStatus(`Abgewählt (${selection.sourceNodeType.toUpperCase()}): ${label}`);
  }
}

function clearActivePath() {
  if (!state.currentGraph) {
    return;
  }

  state.currentGraph.ui.activeSelections = {};
  state.currentGraph.ui.activePath = [];
  state.lastChosenEdgeId = null;
  state.lastChosenNodeId = null;

  if (state.mode === 'view') {
    ensureActivePathSeed();
  }

  renderGraph();
  setStatus('Path cleared.');
}

async function createNewGraphFlow() {
  const name = await showPrompt({
    title: 'New Graph',
    message: 'Graph name:',
    defaultValue: 'New Graph',
    okText: 'Create'
  });

  if (name === null) {
    return;
  }

  const graph = createGraph(name.trim() || 'New Graph');

  try {
    await persistGraph(graph);
    upsertGraphSummary(graph);
    renderGraphList();
    await loadGraphById(graph.id);
    setStatus('Graph created.');
  } catch (error) {
    console.error('Create graph failed:', error);
    await showAlert('Could not create graph file.');
  }
}

async function renameCurrentGraphFlow() {
  if (!state.currentGraph) {
    return;
  }

  const nextName = await showPrompt({
    title: 'Rename Graph',
    message: 'New name:',
    defaultValue: state.currentGraph.name,
    okText: 'Rename'
  });

  if (nextName === null) {
    return;
  }

  state.currentGraph.name = nextName.trim() || 'Untitled Graph';

  try {
    await persistGraph(state.currentGraph);
    upsertGraphSummary(state.currentGraph);
    renderGraph();
    setStatus('Graph renamed.');
  } catch (error) {
    console.error('Rename failed:', error);
    await showAlert('Rename failed while saving file.');
  }
}

async function duplicateCurrentGraphFlow() {
  if (!state.currentGraph) {
    return;
  }

  const defaultName = `${state.currentGraph.name} Copy`;
  const nextName = await showPrompt({
    title: 'Duplicate Graph',
    message: 'New graph name:',
    defaultValue: defaultName,
    okText: 'Duplicate'
  });

  if (nextName === null) {
    return;
  }

  const duplicatePayload = JSON.parse(JSON.stringify(state.currentGraph));
  const createdAt = nowISO();

  duplicatePayload.id = await generateUniqueGraphId();
  duplicatePayload.name = nextName.trim() || defaultName;
  duplicatePayload.version = GRAPH_VERSION;
  duplicatePayload.createdAt = createdAt;
  duplicatePayload.updatedAt = createdAt;

  try {
    const duplicatedGraph = normalizeGraph(duplicatePayload, 'duplicate graph');
    duplicatedGraph.id = duplicatePayload.id;
    duplicatedGraph.name = duplicatePayload.name;
    duplicatedGraph.createdAt = createdAt;
    duplicatedGraph.updatedAt = createdAt;

    await persistGraph(duplicatedGraph);
    upsertGraphSummary(duplicatedGraph);
    renderGraphList();
    await loadGraphById(duplicatedGraph.id);
    setStatus('Graph duplicated.');
  } catch (error) {
    console.error('Duplicate failed:', error);
    await showAlert('Could not duplicate graph file.');
  }
}

async function deleteCurrentGraphFlow() {
  if (!state.currentGraph) {
    return;
  }

  const yes = await confirm(`Delete graph "${state.currentGraph.name}"?`, {
    title: 'Delete Graph',
    kind: 'warning'
  });

  if (!yes) {
    return;
  }

  const graphId = state.currentGraph.id;

  try {
    await remove(graphPath(graphId), { baseDir: BaseDirectory.AppData });
  } catch (error) {
    console.warn('Delete main graph file failed:', error);
  }

  state.graphSummaries = state.graphSummaries.filter((item) => item.id !== graphId);

  if (state.graphSummaries.length > 0) {
    await loadGraphFromSummary(state.graphSummaries[0]);
  } else {
    const fresh = createGraph('New Graph');
    await persistGraph(fresh);
    state.graphSummaries = [];
    upsertGraphSummary(fresh);
    await loadGraphById(fresh.id);
  }

  renderGraphList();
  setStatus('Graph deleted.');
}

async function exportCurrentGraph() {
  if (!state.currentGraph) {
    return;
  }

  enforceGraphConsistency(state.currentGraph);

  try {
    const exportType = await showSelect({
      title: 'Export Graph',
      message: 'Choose export format:',
      okText: 'Export',
      defaultValue: 'json',
      options: [
        { value: 'json', label: 'JSON' },
        { value: 'picture', label: 'Picture (SVG)' },
        { value: 'markdown-todo', label: 'Markdown Todo' }
      ]
    });

    if (!exportType) {
      return;
    }

    if (exportType === 'json') {
      await exportGraphAsJson(state.currentGraph);
      return;
    }

    if (exportType === 'picture') {
      await exportGraphAsPicture(state.currentGraph);
      return;
    }

    if (exportType === 'markdown-todo') {
      await exportGraphAsMarkdownTodo(state.currentGraph);
      return;
    }
  } catch (error) {
    console.error('Export failed:', error);
    await showAlert('Export failed.');
  }
}

async function exportGraphAsJson(graph) {
  const targetPath = await save({
    title: 'Export Graph JSON',
    defaultPath: `${sanitizeFileName(graph.name)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (!targetPath) {
    return;
  }

  await writeTextFile(targetPath, JSON.stringify(graph, null, 2));
  setStatus('Graph exported as JSON.');
}

function collectActiveEndNodes(graph) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const selections = getActiveSelections(graph);

  const orderedActiveNodeIds = [];
  const activeNodeSeen = new Set();

  (graph.ui.activePath || []).forEach((entry) => {
    if (!nodeById.has(entry) || activeNodeSeen.has(entry)) {
      return;
    }
    activeNodeSeen.add(entry);
    orderedActiveNodeIds.push(entry);
  });

  if (orderedActiveNodeIds.length === 0 && graph.nodes[0]) {
    orderedActiveNodeIds.push(graph.nodes[0].id);
  }

  return orderedActiveNodeIds
    .filter((nodeId) => {
      const chosenOutgoing = Array.isArray(selections[nodeId]) ? selections[nodeId] : [];
      const hasActiveOutgoing = chosenOutgoing.some((edgeId) => {
        const edge = edgeById.get(edgeId);
        return Boolean(
          edge && edge.from === nodeId && edgeHasTarget(edge) && nodeById.has(edge.to)
        );
      });
      return !hasActiveOutgoing;
    })
    .map((nodeId) => nodeById.get(nodeId))
    .filter(Boolean);
}

function buildMarkdownTodo(graph) {
  const dateStamp = formatDateStamp();
  const endNodes = collectActiveEndNodes(graph);
  const lines = [`# ${graph.name} - ${dateStamp}`, '', '## Todo'];

  if (endNodes.length === 0) {
    lines.push('- [ ] (No active end nodes)');
    return lines.join('\n');
  }

  endNodes.forEach((node) => {
    lines.push(`- [ ] ${node.text || node.id}`);
  });

  return lines.join('\n');
}

async function exportGraphAsMarkdownTodo(graph) {
  const dateStamp = formatDateStamp();
  const targetPath = await save({
    title: 'Export Markdown Todo',
    defaultPath: `${sanitizeFileName(graph.name)}_${dateStamp}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });

  if (!targetPath) {
    return;
  }

  await writeTextFile(targetPath, buildMarkdownTodo(graph));
  setStatus('Graph exported as Markdown Todo.');
}

function buildGraphPictureSvg(graph) {
  const context = getPathContext();
  const showViewPath = state.mode === 'view';
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodeSizes = new Map();

  graph.nodes.forEach((node) => {
    const nodeEl = state.nodeElements.get(node.id);
    nodeSizes.set(node.id, {
      width: Math.max(NODE_WIDTH, nodeEl?.offsetWidth || NODE_WIDTH),
      height: Math.max(34, nodeEl?.offsetHeight || 44)
    });
  });

  const bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY
  };

  const pushBounds = (x, y) => {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  };

  const edgeGeometries = [];

  graph.edges.forEach((edge) => {
    const sourceNode = nodeById.get(edge.from);
    if (!sourceNode) {
      return;
    }

    const sourceSize = nodeSizes.get(sourceNode.id) || { width: NODE_WIDTH, height: 44 };
    const sourceCenterX = sourceNode.x + sourceSize.width / 2;
    const sourceCenterY = sourceNode.y + sourceSize.height / 2;
    const targetNode = edgeHasTarget(edge) ? nodeById.get(edge.to) : null;
    const targetSize = targetNode ? nodeSizes.get(targetNode.id) || { width: NODE_WIDTH, height: 44 } : null;
    const isDangling = !targetNode;

    let endX = 0;
    let endY = 0;

    if (isDangling) {
      const danglingPoint = getDanglingEdgePoint(graph, sourceNode, edge);
      endX = danglingPoint.x;
      endY = danglingPoint.y;
    } else {
      endX = targetNode.x + targetSize.width / 2;
      endY = targetNode.y + 1;
    }

    const startFromBottom = endY >= sourceCenterY;
    const startX = sourceCenterX;
    const startY = startFromBottom ? sourceNode.y + sourceSize.height : sourceNode.y;

    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const verticalBend = Math.max(54, Math.abs(deltaY) * 0.5);
    const horizontalBend = deltaX * 0.35;
    const c1x = startX + horizontalBend;
    const c1y = startY + (startFromBottom ? verticalBend : -verticalBend);
    const c2x = endX;
    const c2y = endY - verticalBend;
    const midpoint = cubicBezierPoint(
      0.5,
      { x: startX, y: startY },
      { x: c1x, y: c1y },
      { x: c2x, y: c2y },
      { x: endX, y: endY }
    );

    const isEditSelected = state.mode === 'edit' && state.selectedEdgeId === edge.id;
    const isLineSelected = isEditSelected && state.selectedEdgeSelectionSource === 'line';
    const isSelectionActive = context.selectedEdgeSet.has(edge.id);
    const isViewActive = showViewPath && context.activeEdgeId === edge.id;
    const isStronglyActive = isSelectionActive || isViewActive;
    const isPath = showViewPath && context.edgePathSet.has(edge.id);

    const markerVariant = isStronglyActive ? 'active' : isPath ? 'path' : 'default';
    const stroke = isStronglyActive
      ? '#0a4dbb'
      : isPath
        ? '#46763d'
        : isLineSelected
          ? '#2f2f2f'
          : '#525252';
    const dash = isLineSelected ? '9 6' : isDangling ? '8 6' : null;
    const strokeWidth = isStronglyActive || isLineSelected ? 3 : 2;
    const button = findButtonForEdge(edge);
    const label = button?.text || 'Choice';

    pushBounds(startX, startY);
    pushBounds(c1x, c1y);
    pushBounds(c2x, c2y);
    pushBounds(endX, endY);
    pushBounds(midpoint.x - 85, midpoint.y - 20);
    pushBounds(midpoint.x + 85, midpoint.y + 20);

    edgeGeometries.push({
      edgeId: edge.id,
      startX,
      startY,
      c1x,
      c1y,
      c2x,
      c2y,
      endX,
      endY,
      midpoint,
      markerVariant,
      stroke,
      dash,
      strokeWidth,
      label
    });
  });

  graph.nodes.forEach((node) => {
    const size = nodeSizes.get(node.id) || { width: NODE_WIDTH, height: 44 };
    pushBounds(node.x, node.y);
    pushBounds(node.x + size.width, node.y + size.height);
  });

  if (!Number.isFinite(bounds.minX)) {
    bounds.minX = 0;
    bounds.minY = 0;
    bounds.maxX = 820;
    bounds.maxY = 620;
  }

  const padding = 80;
  const width = Math.max(320, Math.ceil(bounds.maxX - bounds.minX + padding * 2));
  const height = Math.max(220, Math.ceil(bounds.maxY - bounds.minY + padding * 2));
  const offsetX = padding - bounds.minX;
  const offsetY = padding - bounds.minY;

  const edgesSvg = edgeGeometries
    .map((geometry) => {
      const pathD = [
        'M',
        geometry.startX + offsetX,
        geometry.startY + offsetY,
        'C',
        geometry.c1x + offsetX,
        geometry.c1y + offsetY,
        ',',
        geometry.c2x + offsetX,
        geometry.c2y + offsetY,
        ',',
        geometry.endX + offsetX,
        geometry.endY + offsetY
      ].join(' ');

      return `<path d="${pathD}" fill="none" stroke="${geometry.stroke}" stroke-width="${
        geometry.strokeWidth
      }"${geometry.dash ? ` stroke-dasharray="${geometry.dash}"` : ''} marker-start="url(#edge-start-${
        geometry.markerVariant
      })" marker-end="url(#arrow-head-${geometry.markerVariant})" />`;
    })
    .join('\n');

  const labelsSvg = edgeGeometries
    .map((geometry) => {
      const labelText = geometry.label || 'Choice';
      const labelWidth = clamp(labelText.length * 7 + 16, 44, 170);
      const labelHeight = 24;
      const x = geometry.midpoint.x + offsetX - labelWidth / 2;
      const y = geometry.midpoint.y + offsetY - labelHeight / 2;
      const isActive = context.selectedEdgeSet.has(geometry.edgeId) || (showViewPath && context.activeEdgeId === geometry.edgeId);
      const fill = isActive ? '#0a4dbb' : '#d4d0c8';
      const color = isActive ? '#ffffff' : '#000000';

      return `<g>
<rect x="${x}" y="${y}" width="${labelWidth}" height="${labelHeight}" fill="${fill}" stroke="#585858" stroke-width="1" />
<text x="${x + labelWidth / 2}" y="${y + 16}" text-anchor="middle" font-family="Tahoma, Arial, sans-serif" font-size="12" font-weight="700" fill="${color}">${escapeXml(
        labelText
      )}</text>
</g>`;
    })
    .join('\n');

  const nodesSvg = graph.nodes
    .map((node) => {
      const size = nodeSizes.get(node.id) || { width: NODE_WIDTH, height: 44 };
      const x = node.x + offsetX;
      const y = node.y + offsetY;
      const w = size.width;
      const h = size.height;
      const nodeColor = getNodeBaseColor(node);
      const nodeTextColor = getReadableTextColor(nodeColor);
      const titleColor =
        nodeTextColor === '#ffffff' ? mixColor(nodeColor, 0.2) : mixColor(nodeColor, -0.12);
      const isSelected = graph.ui.selectedNodeId === node.id;
      const isPath = showViewPath && context.nodePathSet.has(node.id);
      const isActive =
        context.selectedNodeSet.has(node.id) || (showViewPath && context.activeNodeId === node.id);
      const isActiveCurrent = showViewPath && context.activeNodeId === node.id;
      const titleFill = isActiveCurrent ? '#0a4dbb' : titleColor;
      const titleText = isActiveCurrent ? '#ffffff' : nodeTextColor;

      const titleX = x + 7;
      const titleY = y + 7;
      const titleW = Math.max(36, w - 66);
      const titleH = 22;
      const typeX = titleX + titleW + 6;
      const typeY = titleY;
      const typeW = 46;
      const typeH = 22;
      const typeFill = node.type === 'or' ? '#d5e8c8' : '#d7e4ff';

      const overlays = [];
      if (isPath) {
        overlays.push(
          `<rect x="${x - 2}" y="${y - 2}" width="${w + 4}" height="${h + 4}" fill="none" stroke="rgba(70,118,61,0.65)" stroke-width="2" />`
        );
      }
      if (isActive) {
        overlays.push(
          `<rect x="${x - 3}" y="${y - 3}" width="${w + 6}" height="${h + 6}" fill="none" stroke="#0a4dbb" stroke-width="3" />`
        );
      }
      if (isActiveCurrent) {
        overlays.push(
          `<rect x="${x - 8}" y="${y - 8}" width="${w + 16}" height="${h + 16}" fill="none" stroke="#ffffff" stroke-width="4" />`
        );
        overlays.push(
          `<rect x="${x - 10}" y="${y - 10}" width="${w + 20}" height="${h + 20}" fill="none" stroke="#0a4dbb" stroke-width="2" />`
        );
      }
      if (isSelected) {
        overlays.push(
          `<rect x="${x - 5}" y="${y - 5}" width="${w + 10}" height="${h + 10}" fill="none" stroke="#000000" stroke-width="3" stroke-dasharray="3 3" />`
        );
      }

      return `<g>
${overlays.join('\n')}
<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${nodeColor}" stroke="#404040" stroke-width="2" />
<line x1="${x + 1}" y1="${y + 1}" x2="${x + w - 1}" y2="${y + 1}" stroke="#ffffff" stroke-width="1" />
<line x1="${x + 1}" y1="${y + 1}" x2="${x + 1}" y2="${y + h - 1}" stroke="#ffffff" stroke-width="1" />
<rect x="${titleX}" y="${titleY}" width="${titleW}" height="${titleH}" fill="${titleFill}" stroke="#707070" stroke-width="1" />
<text x="${titleX + 7}" y="${titleY + 15}" font-family="Tahoma, Arial, sans-serif" font-size="12" font-weight="700" fill="${titleText}">${escapeXml(
        node.text
      )}</text>
<rect x="${typeX}" y="${typeY}" width="${typeW}" height="${typeH}" fill="${typeFill}" stroke="#707070" stroke-width="1" />
<text x="${typeX + typeW / 2}" y="${typeY + 15}" text-anchor="middle" font-family="Tahoma, Arial, sans-serif" font-size="12" fill="#000000">${escapeXml(
        String(node.type || 'xor').toUpperCase()
      )}</text>
</g>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <marker id="edge-start-default" markerWidth="12" markerHeight="12" refX="6" refY="6" orient="auto" markerUnits="userSpaceOnUse">
      <circle cx="6" cy="6" r="4.2" fill="#d9d9d9" stroke="#575757" stroke-width="1.5"></circle>
    </marker>
    <marker id="edge-start-path" markerWidth="12" markerHeight="12" refX="6" refY="6" orient="auto" markerUnits="userSpaceOnUse">
      <circle cx="6" cy="6" r="4.2" fill="#dce8d8" stroke="#7b9c74" stroke-width="1.5"></circle>
    </marker>
    <marker id="edge-start-active" markerWidth="12" markerHeight="12" refX="6" refY="6" orient="auto" markerUnits="userSpaceOnUse">
      <circle cx="6" cy="6" r="4.2" fill="#d6e5ff" stroke="#1458c2" stroke-width="1.5"></circle>
    </marker>
    <marker id="arrow-head-default" markerWidth="12" markerHeight="12" refX="12" refY="6" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M 0 0 L 12 6 L 0 12 z" fill="#575757"></path>
    </marker>
    <marker id="arrow-head-path" markerWidth="12" markerHeight="12" refX="12" refY="6" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M 0 0 L 12 6 L 0 12 z" fill="#7b9c74"></path>
    </marker>
    <marker id="arrow-head-active" markerWidth="12" markerHeight="12" refX="12" refY="6" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M 0 0 L 12 6 L 0 12 z" fill="#1458c2"></path>
    </marker>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="#b5b5b5"></rect>
  ${edgesSvg}
  ${labelsSvg}
  ${nodesSvg}
</svg>`;
}

async function exportGraphAsPicture(graph) {
  const targetPath = await save({
    title: 'Export Graph Picture',
    defaultPath: `${sanitizeFileName(graph.name)}.svg`,
    filters: [{ name: 'Picture', extensions: ['svg'] }]
  });

  if (!targetPath) {
    return;
  }

  const svg = buildGraphPictureSvg(graph);
  await writeTextFile(targetPath, svg);
  setStatus('Graph exported as picture (SVG).');
}

async function importGraphFromJson() {
  try {
    const selected = await open({
      title: 'Import Graph JSON',
      multiple: false,
      directory: false,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });

    if (!selected || Array.isArray(selected)) {
      return;
    }

    const json = await readTextFile(selected);
    const parsed = JSON.parse(json);
    const graph = normalizeGraph(parsed, 'imported file');

    const idTakenInMemory = state.graphSummaries.some((item) => item.id === graph.id);
    const idTakenOnDisk = await exists(graphPath(graph.id), { baseDir: BaseDirectory.AppData });

    if (idTakenInMemory || idTakenOnDisk) {
      graph.id = uid('g');
    }

    graph.updatedAt = nowISO();

    await persistGraph(graph);
    upsertGraphSummary(graph);
    renderGraphList();
    await loadGraphById(graph.id);
    setStatus('Graph imported.');
  } catch (error) {
    console.error('Import failed:', error);
    await showAlert('Import failed. Make sure the file is valid JSON and follows graph schema v1.');
  }
}

function showModal(options) {
  if (state.modalResolver) {
    resolveModal(false);
  }

  state.modalOptions = options;
  el.modalTitle.textContent = options.title || 'Dialog';
  el.modalMessage.textContent = options.message || '';

  const withInput = options.withInput !== false;
  const withSelect = Array.isArray(options.selectOptions) && options.selectOptions.length > 0;
  el.modalInput.classList.toggle('hidden', !withInput);
  el.modalInput.value = withInput ? options.defaultValue || '' : '';
  el.modalSelect.classList.toggle('hidden', !withSelect);
  el.modalSelect.innerHTML = '';
  if (withSelect) {
    options.selectOptions.forEach((option) => {
      const value =
        typeof option === 'string'
          ? option
          : typeof option?.value === 'string'
            ? option.value
            : '';
      if (!value) {
        return;
      }

      const label =
        typeof option === 'string'
          ? option
          : typeof option?.label === 'string'
            ? option.label
            : value;
      const item = document.createElement('option');
      item.value = value;
      item.textContent = label;
      el.modalSelect.appendChild(item);
    });

    const defaultSelectValue = options.defaultSelectValue || el.modalSelect.options[0]?.value || '';
    el.modalSelect.value = defaultSelectValue;
  }

  el.modalOk.textContent = options.okText || 'OK';
  el.modalCancel.textContent = options.cancelText || 'Cancel';
  el.modalCancel.classList.toggle('hidden', options.hideCancel === true);

  el.modalOverlay.classList.remove('hidden');

  if (withInput) {
    requestAnimationFrame(() => {
      el.modalInput.focus();
      el.modalInput.select();
    });
  } else if (withSelect) {
    requestAnimationFrame(() => {
      el.modalSelect.focus();
    });
  } else {
    requestAnimationFrame(() => {
      el.modalOk.focus();
    });
  }

  return new Promise((resolve) => {
    state.modalResolver = resolve;
  });
}

function resolveModal(confirmed) {
  if (!state.modalResolver) {
    return;
  }

  const resolve = state.modalResolver;
  state.modalResolver = null;

  const value = el.modalInput.value;
  const selectedValue = el.modalSelect.value;
  el.modalOverlay.classList.add('hidden');

  resolve({ confirmed, value, selectedValue });
}

async function showPrompt(options) {
  const result = await showModal({
    title: options.title,
    message: options.message,
    defaultValue: options.defaultValue || '',
    okText: options.okText || 'OK',
    cancelText: options.cancelText || 'Cancel',
    hideCancel: false,
    withInput: true
  });

  if (!result.confirmed) {
    return null;
  }

  return result.value;
}

async function showSelect(options) {
  const result = await showModal({
    title: options.title || 'Select',
    message: options.message || '',
    okText: options.okText || 'OK',
    cancelText: options.cancelText || 'Cancel',
    hideCancel: false,
    withInput: false,
    selectOptions: options.options || [],
    defaultSelectValue: options.defaultValue || ''
  });

  if (!result.confirmed) {
    return null;
  }

  return result.selectedValue;
}

async function showAlert(messageText) {
  await showModal({
    title: 'KnotenWerk',
    message: messageText,
    okText: 'OK',
    hideCancel: true,
    withInput: false
  });
}
