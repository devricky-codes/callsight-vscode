import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { parseFile, parseFileContent, buildCallGraph, detectEntryPoints, partitionFlows, initTreeSitter, FunctionNode, CallEdge, DiffGraph, NodeDiffStatus, EdgeDiffStatus, FILE_EXTENSION_MAP, SupportedLanguage, Logger } from '@codeflow-map/core';
import { openCallSightPanel, ensurePanel, currentPanel, revealLastResult, hasLastResult } from './webview/panel';

let treeSitterInitialized = false;
let outputChannel: vscode.OutputChannel;

const DEFAULT_SCAN_BATCH_SIZE = 50;

function getScanBatchSize(): number {
  return vscode.workspace.getConfiguration('callsight').get<number>('scanBatchSize') || DEFAULT_SCAN_BATCH_SIZE;
}

/** Rough byte-size estimate without serialising the entire graph. */
function estimateGraphSize(graph: { nodes: any[]; edges: any[]; flows: any[]; orphans: string[] }): number {
  const avgNodeBytes = 250; // id + name + filePath + numbers + booleans
  const avgEdgeBytes = 120; // from + to + line
  const avgFlowBytes = 80;  // id + entryPoint + per-nodeId ~40 chars
  const flowNodeIdBytes = graph.flows.reduce((sum, f) => sum + f.nodeIds.length * 40, 0);
  const orphanBytes = graph.orphans.reduce((sum, id) => sum + id.length + 4, 0);
  return graph.nodes.length * avgNodeBytes
       + graph.edges.length * avgEdgeBytes
       + graph.flows.length * avgFlowBytes
       + flowNodeIdBytes
       + orphanBytes;
}

const DISCOVERY_EXCLUDES = [
  '**/node_modules/**', '**/venv/**', '**/.venv/**',
  '**/__pycache__/**', '**/vendor/**', '**/target/**',
  '**/.git/**', '**/dist/**', '**/build/**',
  '**/.next/**', '**/.turbo/**', '**/coverage/**',
  '**/.gradle/**', '**/.cache/**', '**/site-packages/**',
  '**/.mypy_cache/**', '**/.pytest_cache/**',
  '**/out/**', '**/bin/**', '**/obj/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '**/__specs__/**','**/test/**', '**/spec/**'
];

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('CallSight');
  context.subscriptions.push(outputChannel);

  const log: Logger = (msg: string) => {
    const ts = new Date().toISOString().slice(11, 23);
    outputChannel.appendLine(`[${ts}] ${msg}`);
  };

  const analyzeWorkspaceCmd = vscode.commands.registerCommand('callsight.analyzeWorkspace', analyzeWorkspace);
  const analyzeCurrentFileCmd = vscode.commands.registerCommand('callsight.analyzeCurrentFile', analyzeActiveEditor);
  const launchCmd = vscode.commands.registerCommand('callsight.launch', () => {
    if (hasLastResult()) {
      revealLastResult();
    } else {
      analyzeWorkspace();
    }
  });

  context.subscriptions.push(analyzeWorkspaceCmd, analyzeCurrentFileCmd, launchCmd);

  async function analyzeWorkspace() {
    try {
      const wasmDir = vscode.Uri.joinPath(context.extensionUri, 'grammars').fsPath;
      if (!treeSitterInitialized) {
        log('Initializing Tree-sitter...');
        await initTreeSitter(wasmDir);
        treeSitterInitialized = true;
        log('Tree-sitter initialized');
      }

      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "CallSight: Scanning Workspace..." },
        async () => {
          const startTime = Date.now();
          log('=== Workspace analysis started ===');

          // Open the panel early so SCAN_PROGRESS messages have somewhere to land
          ensurePanel(context, wasmDir);

          const config = vscode.workspace.getConfiguration('callsight');
          const blacklist = config.get<string[]>('blacklist') || [];
          const whitelist = config.get<string[]>('whitelist') || [];
          const userExcludes = config.get<string[]>('exclude') || [];
          const allExcludes = [...DISCOVERY_EXCLUDES, ...userExcludes];
          
          const excludePattern = `{${allExcludes.join(',')}}`;
          // Derive include pattern from FILE_EXTENSION_MAP so new languages in core are picked up automatically
          const extGlob = Object.keys(FILE_EXTENSION_MAP).map(e => e.replace('.', '')).join(',');
          const uris = await vscode.workspace.findFiles(`**/*.{${extGlob}}`, excludePattern);
          log(`File discovery: ${uris.length} files found in ${Date.now() - startTime}ms`);
          
          if (uris.length === 0) {
            vscode.window.showInformationMessage('CallSight: No supported files found in workspace.');
            return;
          }

          function matchesPattern(filePath: string, pattern: string): boolean {
            const parts = filePath.split(/[/\\]/);
            return parts.some(part => minimatch(part, pattern)) ||
                   minimatch(filePath, pattern) ||
                   minimatch(filePath, `**/${pattern}/**`);
          }

          function shouldScanFile(filePath: string): boolean {
            // Check blacklist
            for (const pattern of blacklist) {
              if (matchesPattern(filePath, pattern)) return false;
            }
            // Check whitelist
            if (whitelist.length === 0) return true;
            return whitelist.some(pattern => matchesPattern(filePath, pattern));
          }

          const allFunctions: any[] = [];
          const allCalls: any[] = [];
          let scannedFiles = 0;

          // Pre-filter to get only scannable files
          const filesToScan: { filePath: string; absPath: string; languageId: SupportedLanguage }[] = [];
          for (const uri of uris) {
            const filePath = vscode.workspace.asRelativePath(uri).replace(/\\/g, '/');
            if (!shouldScanFile(filePath)) continue;
            const absPath = uri.fsPath;
            const languageId = FILE_EXTENSION_MAP[path.extname(absPath)];
            if (!languageId) continue;
            filesToScan.push({ filePath, absPath, languageId });
          }

          const totalFiles = filesToScan.length;
          const batchSize = getScanBatchSize();
          log(`Files to scan: ${totalFiles} (batch size: ${batchSize})`);

          // Process in batches for parallel I/O without exhausting file handles
          for (let i = 0; i < totalFiles; i += batchSize) {
            const batch = filesToScan.slice(i, i + batchSize);
            const results = await Promise.all(
              batch.map(f => parseFile(f.filePath, f.absPath, wasmDir, f.languageId))
            );
            for (const { functions, calls } of results) {
              allFunctions.push(...functions);
              allCalls.push(...calls);
            }
            scannedFiles += batch.length;
            currentPanel?.webview.postMessage({
              type: 'SCAN_PROGRESS',
              scannedFiles,
              totalFiles,
            });
          }

          const scanDoneTime = Date.now();
          log(`File scanning complete: ${allFunctions.length} functions, ${allCalls.length} calls from ${scannedFiles} files in ${scanDoneTime - startTime}ms`);
          
          log('Starting buildCallGraph...');
          const edges = buildCallGraph(allFunctions, allCalls, log);
          log(`buildCallGraph complete: ${edges.length} edges in ${Date.now() - scanDoneTime}ms`);

          log('Starting detectEntryPoints...');
          detectEntryPoints(allFunctions, edges, log);

          log('Starting partitionFlows...');
          const { flows, orphans } = partitionFlows(allFunctions, edges, log);
          log(`partitionFlows complete: ${flows.length} flows, ${orphans.length} orphans`);

          const graphBuildTime = Date.now();
          log(`Graph construction total: ${graphBuildTime - scanDoneTime}ms`);

          const graph = {
            nodes: allFunctions,
            edges,
            flows,
            orphans,
            scannedFiles,
            durationMs: Date.now() - startTime
          };

          const graphPayloadSize = estimateGraphSize(graph);
          log(`Graph payload: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.flows.length} flows, ${graph.orphans.length} orphans, ~${(graphPayloadSize / 1024 / 1024).toFixed(1)}MB est.`);
          log('Posting graph to webview...');
          openCallSightPanel(context, graph, wasmDir, 'workspace');
          log(`Graph posted to webview (${Date.now() - graphBuildTime}ms)`);
          log(`=== Workspace analysis complete: ${((Date.now() - startTime) / 1000).toFixed(1)}s total ===`);
          outputChannel.show(true);

          // Persistent notification so the user can relaunch the panel if they closed it
          vscode.window.showInformationMessage(
            `CallSight: Scan complete (${scannedFiles} files in ${((Date.now() - startTime) / 1000).toFixed(1)}s)`,
            'Show CallSight'
          ).then(choice => {
            if (choice === 'Show CallSight') {
              revealLastResult();
            }
          });
        }
      );
    } catch (e: any) {
      log?.(`ERROR in workspace analysis: ${e.message}\n${e.stack}`);
      vscode.window.showErrorMessage('CallSight Workspace Analysis Failed: ' + e.message);
    }
  }

  async function analyzeActiveEditor() {
    try {
      const wasmDir = vscode.Uri.joinPath(context.extensionUri, 'grammars').fsPath;
      if (!treeSitterInitialized) {
        await initTreeSitter(wasmDir);
        treeSitterInitialized = true;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("CallSight: No active text editor to analyze. Make sure you're focused on a code file, or use 'Visualize Entire Codebase' instead.");
        return;
      }

      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "CallSight: Analyzing..." },
        async () => {
          const startTime = Date.now();
          const filePath = vscode.workspace.asRelativePath(editor.document.uri).replace(/\\/g, '/');
          const absPath = editor.document.uri.fsPath;
          
          const languageId = FILE_EXTENSION_MAP[path.extname(absPath)];
          if (!languageId) {
            vscode.window.showErrorMessage('CallSight: Unsupported file type.');
            return;
          }
          
          const { functions, calls } = await parseFile(filePath, absPath, wasmDir, languageId);
          
          const edges = buildCallGraph(functions, calls, log);
          detectEntryPoints(functions, edges, log);
          const { flows, orphans } = partitionFlows(functions, edges, log);

          const graph = {
            nodes: functions,
            edges,
            flows,
            orphans,
            scannedFiles: 1,
            durationMs: Date.now() - startTime
          };

          openCallSightPanel(context, graph, wasmDir, 'file');
        }
      );
    } catch (e: any) {
      vscode.window.showErrorMessage('CallSight Analysis Failed: ' + e.message);
    }
  }
}

export function deactivate() {}

export async function analyzeFilePath(relPath: string, wasmDir: string) {
  try {
    if (!treeSitterInitialized) {
      await initTreeSitter(wasmDir);
      treeSitterInitialized = true;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const absPath = path.join(workspaceFolder, relPath);
    const languageId = FILE_EXTENSION_MAP[path.extname(absPath)];
    if (!languageId) {
      vscode.window.showErrorMessage('CallSight: Unsupported file type.');
      return;
    }

    const startTime = Date.now();
    const { functions, calls } = await parseFile(relPath, absPath, wasmDir, languageId);
    const edges = buildCallGraph(functions, calls);
    detectEntryPoints(functions, edges);
    const { flows, orphans } = partitionFlows(functions, edges);

    const graph = {
      nodes: functions,
      edges,
      flows,
      orphans,
      scannedFiles: 1,
      durationMs: Date.now() - startTime
    };

    const config = vscode.workspace.getConfiguration('callsight');
    const blacklist = config.get<string[]>('exclude') || [
      "node_modules", "dist", "build", ".git", "__pycache__", "*.test.*", "*.spec.*"
    ];
    currentPanel?.webview.postMessage({ type: 'LOAD_GRAPH', graph, callsightConfig: { blacklist }, mode: 'file' });
  } catch (e: any) {
    vscode.window.showErrorMessage('CallSight Refresh Failed: ' + e.message);
  }
}

// === Git Diff Logic ===

function execGit(cwd: string, args: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.exec(`git ${args}`, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export async function checkGitAvailable(): Promise<{ available: boolean; reason?: string }> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) return { available: false, reason: 'No workspace folder open' };
  try {
    await execGit(workspaceFolder, 'rev-parse --is-inside-work-tree');
    return { available: true };
  } catch {
    return { available: false, reason: 'This workspace is not a Git repository' };
  }
}

export async function validateCommitHash(hash: string): Promise<{ valid: boolean; reason?: string }> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) return { valid: false, reason: 'No workspace folder' };
  try {
    const type = (await execGit(workspaceFolder, `cat-file -t ${hash}`)).trim();
    if (type !== 'commit') return { valid: false, reason: `"${hash}" is a ${type}, not a commit` };
    return { valid: true };
  } catch {
    return { valid: false, reason: `"${hash}" is not a valid Git object` };
  }
}

function detectLanguage(filePath: string): SupportedLanguage | null {
  const ext = path.extname(filePath);
  return FILE_EXTENSION_MAP[ext] ?? null;
}

/**
 * Build a full diff graph between two git references.
 * - No hashes → uncommitted working tree vs HEAD
 * - One hash (hashA) → hashA vs HEAD
 * - Two hashes → hashA vs hashB
 */
export async function computeFullGitDiff(
  wasmDir: string,
  sendProgress: (message: string) => void,
  hashA?: string,
  hashB?: string
): Promise<DiffGraph> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) throw new Error('No workspace folder open');

  // Determine refs and mode
  const isUncommittedMode = !hashA && !hashB;
  const refA = hashA || 'HEAD';
  const refB = hashB || (hashA ? 'HEAD' : undefined); // undefined means working tree

  sendProgress('Identifying changed files...');

  // Build diff command
  let diffCmd: string;
  if (isUncommittedMode) {
    diffCmd = 'diff --name-status HEAD';
  } else if (!hashB) {
    // One hash: compare hashA vs HEAD
    diffCmd = `diff --name-status ${refA} HEAD`;
  } else {
    // Two hashes
    diffCmd = `diff --name-status ${refA} ${refB}`;
  }

  const diffOutput = await execGit(workspaceFolder, diffCmd);
  const diffLines = diffOutput.trim().split('\n').filter(l => l.length > 0);

  if (diffLines.length === 0) throw new Error('No differences found between the specified versions');

  // Parse diff output: status\tfilepath (with optional rename: R100\told\tnew)
  // Normalise all paths to forward slashes for consistent downstream comparisons on Windows
  const diffFiles: { status: string; filePath: string; oldPath?: string }[] = [];
  for (const line of diffLines) {
    const parts = line.split('\t');
    const status = parts[0].charAt(0); // A, M, D, R, C
    if (status === 'R' || status === 'C') {
      diffFiles.push({ status, filePath: parts[2].replace(/\\/g, '/'), oldPath: parts[1].replace(/\\/g, '/') });
    } else {
      diffFiles.push({ status, filePath: parts[1].replace(/\\/g, '/') });
    }
  }

  // Filter to supported languages
  const supportedDiffFiles = diffFiles.filter(f => detectLanguage(f.filePath) !== null);
  if (supportedDiffFiles.length === 0) throw new Error('No supported source files in the diff');

  const diffFilePaths = supportedDiffFiles.map(f => f.filePath);

  // === Build Graph A (old version) ===
  sendProgress(`Analyzing version A (${refA})... (${supportedDiffFiles.length} files)`);
  const aFunctions: FunctionNode[] = [];
  const aCalls: any[] = [];

  const aFiles = supportedDiffFiles.filter(df => {
    if (df.status === 'A') return false;
    return detectLanguage(df.filePath) !== null;
  });

  const batchSize = getScanBatchSize();
  for (let i = 0; i < aFiles.length; i += batchSize) {
    const batch = aFiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (df) => {
        const lang = detectLanguage(df.filePath)!;
        const showPath = (df.oldPath || df.filePath).replace(/\\/g, '/');
        try {
          const content = await execGit(workspaceFolder, `show ${refA}:${showPath}`);
          return await parseFileContent(df.filePath, content, wasmDir, lang);
        } catch {
          return null; // File might not exist at refA
        }
      })
    );
    for (const r of results) {
      if (r) { aFunctions.push(...r.functions); aCalls.push(...r.calls); }
    }
    sendProgress(`Analyzing version A (${refA})... ${Math.min(i + batchSize, aFiles.length)}/${aFiles.length} files`);
  }

  const aEdges = buildCallGraph(aFunctions, aCalls);
  detectEntryPoints(aFunctions, aEdges);

  // === Build Graph B (new version) ===
  const refBLabel = refB || 'working tree';
  sendProgress(`Analyzing version B (${refBLabel})... (${supportedDiffFiles.length} files)`);
  const bFunctions: FunctionNode[] = [];
  const bCalls: any[] = [];

  const bFiles = supportedDiffFiles.filter(df => {
    if (df.status === 'D') return false;
    return detectLanguage(df.filePath) !== null;
  });

  for (let i = 0; i < bFiles.length; i += batchSize) {
    const batch = bFiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (df) => {
        const lang = detectLanguage(df.filePath)!;
        try {
          let content: string;
          if (!refB && isUncommittedMode) {
            content = fs.readFileSync(path.join(workspaceFolder, df.filePath), 'utf-8');
          } else {
            const showRef = refB || 'HEAD';
            content = await execGit(workspaceFolder, `show ${showRef}:${df.filePath.replace(/\\/g, '/')}`);
          }
          return await parseFileContent(df.filePath, content, wasmDir, lang);
        } catch {
          return null; // File might not exist at refB
        }
      })
    );
    for (const r of results) {
      if (r) { bFunctions.push(...r.functions); bCalls.push(...r.calls); }
    }
    sendProgress(`Analyzing version B (${refBLabel})... ${Math.min(i + batchSize, bFiles.length)}/${bFiles.length} files`);
  }

  const bEdges = buildCallGraph(bFunctions, bCalls);
  detectEntryPoints(bFunctions, bEdges);

  // === Compute Node Diff Status ===
  sendProgress('Computing diff status...');

  // Node identity: filePath::functionName (ignoring startLine since lines shift)
  function nodeKey(n: FunctionNode): string {
    return `${n.filePath}::${n.name}`;
  }

  // Group by key; if multiple matches (overloads), index by occurrence order
  function buildNodeKeyMap(nodes: FunctionNode[]): Map<string, FunctionNode[]> {
    const map = new Map<string, FunctionNode[]>();
    for (const n of nodes) {
      const k = nodeKey(n);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(n);
    }
    return map;
  }

  const aNodeMap = buildNodeKeyMap(aFunctions);
  const bNodeMap = buildNodeKeyMap(bFunctions);

  const nodeDiffStatus: Record<string, NodeDiffStatus> = {};
  const mergedNodes: FunctionNode[] = [];
  // Map from A node IDs to merged node IDs
  const aIdToMergedId = new Map<string, string>();

  // Process all B nodes first (they are the "current" version)
  const processedAKeys = new Set<string>();
  for (const [key, bNodes] of bNodeMap) {
    const aNodes = aNodeMap.get(key);
    for (let i = 0; i < bNodes.length; i++) {
      const bNode = bNodes[i];
      mergedNodes.push(bNode);
      if (aNodes && i < aNodes.length) {
        // Match found in A — compare params and return type
        const aNode = aNodes[i];
        aIdToMergedId.set(aNode.id, bNode.id);
        const paramsChanged = JSON.stringify(aNode.params) !== JSON.stringify(bNode.params);
        const returnChanged = aNode.returnType !== bNode.returnType;
        nodeDiffStatus[bNode.id] = (paramsChanged || returnChanged) ? 'changed' : 'unchanged';
      } else {
        nodeDiffStatus[bNode.id] = 'added';
      }
    }
    processedAKeys.add(key);
  }

  // Process remaining A nodes (removed — ghost nodes)
  for (const [key, aNodes] of aNodeMap) {
    const bNodes = bNodeMap.get(key);
    const startIdx = bNodes ? bNodes.length : 0;
    for (let i = startIdx; i < aNodes.length; i++) {
      const aNode = aNodes[i];
      // Create ghost node with a distinct ID
      const ghostId = `ghost::${aNode.id}`;
      const ghostNode: FunctionNode = {
        ...aNode,
        id: ghostId,
        isEntryPoint: false, // ghosts shouldn't be entry points
      };
      mergedNodes.push(ghostNode);
      aIdToMergedId.set(aNode.id, ghostId);
      nodeDiffStatus[ghostId] = 'removed';
    }
    if (!processedAKeys.has(key)) {
      // All nodes in this key are removed
      for (let i = 0; i < (bNodeMap.get(key)?.length ?? 0); i++) {
        // already handled above
      }
      for (let i = 0; i < aNodes.length; i++) {
        if (!aIdToMergedId.has(aNodes[i].id)) {
          const aNode = aNodes[i];
          const ghostId = `ghost::${aNode.id}`;
          const ghostNode: FunctionNode = { ...aNode, id: ghostId, isEntryPoint: false };
          mergedNodes.push(ghostNode);
          aIdToMergedId.set(aNode.id, ghostId);
          nodeDiffStatus[ghostId] = 'removed';
        }
      }
    }
  }

  // === Compute Edge Diff Status ===
  // Use name-based edge identity for matching
  function edgeKey(fromNode: FunctionNode, toNode: FunctionNode): string {
    return `${fromNode.filePath}::${fromNode.name}>>>${toNode.filePath}::${toNode.name}`;
  }

  const aNodeById = new Map(aFunctions.map(n => [n.id, n]));
  const bNodeById = new Map(bFunctions.map(n => [n.id, n]));

  // Build A edge key set
  const aEdgeKeySet = new Set<string>();
  for (const e of aEdges) {
    const fromN = aNodeById.get(e.from);
    const toN = aNodeById.get(e.to);
    if (fromN && toN) aEdgeKeySet.add(edgeKey(fromN, toN));
  }

  // Build B edge key set
  const bEdgeKeySet = new Set<string>();
  for (const e of bEdges) {
    const fromN = bNodeById.get(e.from);
    const toN = bNodeById.get(e.to);
    if (fromN && toN) bEdgeKeySet.add(edgeKey(fromN, toN));
  }

  const mergedEdges: CallEdge[] = [];
  const edgeDiffStatus: Record<string, EdgeDiffStatus> = {};
  const mergedNodeById = new Map(mergedNodes.map(n => [n.id, n]));

  // Add all B edges
  for (const e of bEdges) {
    mergedEdges.push(e);
    const fromN = bNodeById.get(e.from);
    const toN = bNodeById.get(e.to);
    if (fromN && toN) {
      const ek = edgeKey(fromN, toN);
      edgeDiffStatus[`${e.from}->${e.to}`] = aEdgeKeySet.has(ek) ? 'unchanged' : 'added';
    }
  }

  // Add removed edges (from A, not in B) — remap to merged IDs
  for (const e of aEdges) {
    const fromN = aNodeById.get(e.from);
    const toN = aNodeById.get(e.to);
    if (!fromN || !toN) continue;
    const ek = edgeKey(fromN, toN);
    if (!bEdgeKeySet.has(ek)) {
      const mergedFrom = aIdToMergedId.get(e.from) || e.from;
      const mergedTo = aIdToMergedId.get(e.to) || e.to;
      // Only add if both endpoints exist in merged graph
      if (mergedNodeById.has(mergedFrom) && mergedNodeById.has(mergedTo)) {
        const remappedEdge: CallEdge = { from: mergedFrom, to: mergedTo, line: e.line };
        mergedEdges.push(remappedEdge);
        edgeDiffStatus[`${mergedFrom}->${mergedTo}`] = 'removed';
      }
    }
  }

  // === Build merged graph & partition flows ===
  detectEntryPoints(mergedNodes, mergedEdges);
  const { flows, orphans } = partitionFlows(mergedNodes, mergedEdges);

  // Filter flows: only include flows where at least one node belongs to a diff-affected file
  const diffFileSet = new Set(diffFilePaths);
  const filteredFlows = flows.filter(flow =>
    flow.nodeIds.some(nid => {
      const node = mergedNodeById.get(nid);
      return node && diffFileSet.has(node.filePath);
    })
  );

  // Also filter orphans
  const filteredOrphans = orphans.filter(nid => {
    const node = mergedNodeById.get(nid);
    return node && diffFileSet.has(node.filePath);
  });

  // Collect all node IDs that are in filtered flows + orphans
  const includedNodeIds = new Set<string>();
  for (const flow of filteredFlows) {
    for (const nid of flow.nodeIds) includedNodeIds.add(nid);
  }
  for (const nid of filteredOrphans) includedNodeIds.add(nid);

  const finalNodes = mergedNodes.filter(n => includedNodeIds.has(n.id));
  const finalEdges = mergedEdges.filter(e => includedNodeIds.has(e.from) && includedNodeIds.has(e.to));

  const diffGraph: DiffGraph = {
    nodes: finalNodes,
    edges: finalEdges,
    flows: filteredFlows,
    orphans: filteredOrphans,
    scannedFiles: supportedDiffFiles.length,
    durationMs: 0,
    nodeDiffStatus,
    edgeDiffStatus,
    diffFiles: diffFilePaths,
    isDiffMode: true,
  };

  return diffGraph;
}
