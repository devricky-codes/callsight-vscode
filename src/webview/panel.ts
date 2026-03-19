import * as vscode from 'vscode';
import * as path from 'path';
import { Graph } from '@codeflow-map/core';
import { checkGitAvailable, validateCommitHash, computeFullGitDiff, analyzeFilePath } from '../extension';
import { initTreeSitter } from '@codeflow-map/core';

export let currentPanel: vscode.WebviewPanel | undefined;
let currentWasmDir: string | undefined;
let currentFilePath: string | undefined;
let treeSitterReady = false;
let messageHandlerAttached = false;

/**
 * Max number of nodes/edges to send in a single postMessage chunk.
 * Keeps each serialised message well under V8's ~512 MB string limit.
 */
const CHUNK_SIZE = 5_000;

/**
 * Posts a graph to the webview in chunks so that JSON.stringify never
 * has to serialise the entire graph in one call.
 */
function postGraphToWebview(
  panel: vscode.WebviewPanel,
  graph: any,
  callsightConfig: any,
  mode: string
) {
  const { nodes, edges, flows, orphans, ...meta } = graph;

  // 1. Send metadata + flows/orphans (these are small — just ID strings)
  panel.webview.postMessage({
    type: 'LOAD_GRAPH_START',
    meta,
    flows,
    orphans,
    callsightConfig,
    mode,
    totalNodes: nodes.length,
    totalEdges: edges.length,
  });

  // 2. Stream nodes in chunks
  for (let i = 0; i < nodes.length; i += CHUNK_SIZE) {
    panel.webview.postMessage({
      type: 'LOAD_GRAPH_NODES',
      nodes: nodes.slice(i, i + CHUNK_SIZE),
    });
  }

  // 3. Stream edges in chunks
  for (let i = 0; i < edges.length; i += CHUNK_SIZE) {
    panel.webview.postMessage({
      type: 'LOAD_GRAPH_EDGES',
      edges: edges.slice(i, i + CHUNK_SIZE),
    });
  }

  // 4. Signal completion
  panel.webview.postMessage({ type: 'LOAD_GRAPH_END' });
}

/** Stores the last scan result so the panel can be relaunched from a notification. */
let lastContext: { context: vscode.ExtensionContext; graph: any; wasmDir: string; mode: 'workspace' | 'file' } | undefined;

export function hasLastResult(): boolean {
  return !!lastContext;
}

export function revealLastResult() {
  if (lastContext) {
    openCallSightPanel(lastContext.context, lastContext.graph, lastContext.wasmDir, lastContext.mode);
  }
}

/**
 * Creates the CallSight webview panel and attaches the full message handler if
 * it doesn't already exist. Safe to call multiple times — idempotent.
 * Called early (before scanning) so SCAN_PROGRESS messages have a live panel.
 */
export function ensurePanel(context: vscode.ExtensionContext, wasmDir: string) {
  currentWasmDir = wasmDir;

  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  messageHandlerAttached = false;

  currentPanel = vscode.window.createWebviewPanel(
    'callsight',
    'CallSight',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    }
  );

  currentPanel.onDidDispose(() => {
    currentPanel = undefined;
    messageHandlerAttached = false;
  });
  currentPanel.webview.html = getWebviewHtml(currentPanel.webview, context.extensionUri);

  attachMessageHandler(context);
}

function attachMessageHandler(context: vscode.ExtensionContext) {
  if (!currentPanel || messageHandlerAttached) return;
  messageHandlerAttached = true;

  currentPanel.webview.onDidReceiveMessage(async msg => {
    if (msg.type === 'READY') {
      // If a graph was already sent before READY arrived (panel pre-existed),
      // the graph has already been posted — nothing to do here.
    }

    if (msg.type === 'UPDATE_BLACKLIST') {
      const config = vscode.workspace.getConfiguration('callsight');
      await config.update('exclude', msg.blacklist, vscode.ConfigurationTarget.Workspace);
      vscode.commands.executeCommand('callsight.analyzeWorkspace');
    }

    if (msg.type === 'REFRESH_CURRENT_FILE') {
      if (currentFilePath && currentWasmDir) {
        analyzeFilePath(currentFilePath, currentWasmDir);
      }
    }

    if (msg.type === 'EXPORT_GRAPH_JSON') {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', 'callsight-graph.json')),
        filters: { 'JSON': ['json'] },
      });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(msg.graph, null, 2), 'utf-8'));
        vscode.window.showInformationMessage(`Graph exported to ${uri.fsPath}`);
      }
    }

    if (msg.type === 'GOTO_FUNCTION') {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const uri = vscode.Uri.file(path.join(workspaceFolder, msg.filePath));
      vscode.window.showTextDocument(uri, {
        selection: new vscode.Range(msg.startLine, 0, msg.startLine, 0),
        preserveFocus: false,
      });
    }

    if (msg.type === 'CHECK_GIT_AVAILABLE') {
      const status = await checkGitAvailable();
      currentPanel?.webview.postMessage({ type: 'GIT_STATUS', ...status });
    }

    if (msg.type === 'REQUEST_DIFF_COMPARE') {
      const { hashA, hashB } = msg;
      if (!currentWasmDir) {
        currentPanel?.webview.postMessage({ type: 'DIFF_ERROR', error: 'Extension not initialized' });
        return;
      }

      if (hashA) {
        const validation = await validateCommitHash(hashA);
        if (!validation.valid) {
          currentPanel?.webview.postMessage({ type: 'DIFF_ERROR', error: validation.reason || 'Invalid hash A' });
          return;
        }
      }
      if (hashB) {
        const validation = await validateCommitHash(hashB);
        if (!validation.valid) {
          currentPanel?.webview.postMessage({ type: 'DIFF_ERROR', error: validation.reason || 'Invalid hash B' });
          return;
        }
      }

      try {
        if (!treeSitterReady) {
          await initTreeSitter(currentWasmDir);
          treeSitterReady = true;
        }

        const sendProgress = (message: string) => {
          currentPanel?.webview.postMessage({ type: 'DIFF_PROGRESS', message });
        };

        const diffGraph = await computeFullGitDiff(
          currentWasmDir,
          sendProgress,
          hashA || undefined,
          hashB || undefined
        );

        currentPanel?.webview.postMessage({ type: 'DIFF_RESULT', diffGraph });
      } catch (e: any) {
        currentPanel?.webview.postMessage({ type: 'DIFF_ERROR', error: e.message || 'Git diff failed' });
      }
    }
  });
}

export function openCallSightPanel(
  context: vscode.ExtensionContext,
  graph: Graph,
  wasmDir: string,
  mode: 'workspace' | 'file' = 'workspace'
) {
  currentWasmDir = wasmDir;
  lastContext = { context, graph, wasmDir, mode };

  if (mode === 'file' && graph.nodes.length > 0) {
    currentFilePath = graph.nodes[0].filePath;
  }

  const config = vscode.workspace.getConfiguration('callsight');
  const blacklist = config.get<string[]>('exclude') || [
    "node_modules", "dist", "build", ".git", "__pycache__", "*.test.*", "*.spec.*"
  ];

  if (currentPanel) {
    // Panel already exists (either pre-created by ensurePanel or from a previous run)
    attachMessageHandler(context); // no-op if already attached
    postGraphToWebview(currentPanel, graph, { blacklist }, mode);
    currentPanel.reveal(vscode.ViewColumn.Beside);
  } else {
    ensurePanel(context, wasmDir);
    // Panel just created — webview will fire READY when loaded; send graph on READY
    // We patch the handler to send the graph on the first READY event
    const disposable = currentPanel!.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'READY') {
        if (currentPanel) postGraphToWebview(currentPanel, graph, { blacklist }, mode);
        disposable.dispose();
      }
    });
  }
}

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.css'));

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>CallSight</title>
</head>
<body style="padding: 0; margin: 0; height: 100vh; overflow: hidden; background-color: var(--vscode-editor-background);">
    <div id="root" style="height: 100vh; width: 100vw;"></div>
    <script>
        window.vscode = acquireVsCodeApi();
    </script>
    <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
