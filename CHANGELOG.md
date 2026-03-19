# Changelog

## 0.3.0

### New Commands
- **CallSight: Launch / Reopen** (`callsight.launch`) — instantly reopen the last scan result, or trigger a fresh workspace scan if none exists

### Graph Analysis Tools
- Coupling Heatmap — highlights highly-connected nodes using border colour intensity
- Impact Radius Focus — BFS-highlight everything a node affects up to a configurable depth
- Circular Dependencies — detects and highlights cycles within visible flows
- Complexity Glow — glows nodes by cyclomatic complexity with "Cyclomatic Complexity" label
- Module Clusters — tints nodes by inferred module group

### Git Diff Compare
- Compare any two git commits or uncommitted changes vs HEAD
- Added, removed, and modified nodes/edges highlighted with distinct colours
- Sidebar auto-filters to show only diff-affected flows and functions
- Loading overlay with animated graph-building canvas loader

### Sidebar Improvements
- Selecting a function now automatically clears the active flow selection (and vice versa)
- "Only workflows and functions with diff are listed" hint shown under Git Compare

### Canvas & Search
- Isolate-by-node search now uses prefix matching instead of fuzzy search
- 250ms debounce on isolate search to avoid flickering dropdown
- Go-to-Root dropdown clears the isolate search when jumping to a node

### UX Enhancements
- Persistent notification after workspace scan with "Show CallSight" action to reopen without rescanning
- Animated graph-building canvas loader during scan and diff operations
- Dismissible hint banner when a function is focused, explaining faded nodes/edges behaviour

### Removed
- Removed `callsight.autoRefresh` setting (was non-functional)

## 0.2.0

- Added link to GitHub repository for source verification and contributions
- Added link to [@codeflow-map/core](https://www.npmjs.com/package/@codeflow-map/core) npm package for building custom tools and MCP servers
- Updated README with Contributing & Source Code section

## 0.1.0 — Initial Release

- Analyze entire workspace or current file with Tree-sitter powered parsing
- Interactive React Flow canvas with draggable function nodes
- Support for TypeScript, JavaScript, TSX, JSX, Python, and Go
- Call-flow partitioning into independent execution flows
- Sidebar with file tree and function list
- Minimap for large graphs
- Right-click "Trace Flow From This Function" context menu
- Configurable exclude patterns, layout direction, and max node warnings
- Fully local — no cloud, no LLM, no telemetry
