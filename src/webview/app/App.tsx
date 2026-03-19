import React, { useEffect, useState } from 'react';
import FlowCanvas from './components/FlowCanvas';
import Sidebar from './components/Sidebar';
import GraphLoader from './components/GraphLoader';
import { Graph, DiffGraph } from '@codeflow-map/core';

export interface GraphAnalysisState {
  heatmap: boolean;
  impactRadius: boolean;
  impactDepth: number;
  circularDependency: boolean;
  complexityGlow: boolean;
  moduleClustering: boolean;
}

// Declare VS Code API interface
declare global {
  interface Window {
    vscode: {
      postMessage: (msg: any) => void;
    };
  }
}

export default function App() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFlows, setSelectedFlows] = useState<Set<string>>(new Set());
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [mode, setMode] = useState<'workspace' | 'file'>('workspace');

  // Diff state
  const [diffGraph, setDiffGraph] = useState<DiffGraph | null>(null);
  const [isDiffMode, setIsDiffMode] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffProgress, setDiffProgress] = useState('');
  const [diffError, setDiffError] = useState<string | null>(null);
  const [gitAvailable, setGitAvailable] = useState<{ available: boolean; reason?: string }>({ available: true });
  const [singleFileBannerDismissed, setSingleFileBannerDismissed] = useState(false);
  const [focusHintDismissed, setFocusHintDismissed] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ scannedFiles: number; totalFiles: number } | null>(null);

  const [analysisState, setAnalysisState] = useState<GraphAnalysisState>({
    heatmap: false,
    impactRadius: false,
    impactDepth: 2,
    circularDependency: false,
    complexityGlow: false,
    moduleClustering: false
  });

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'LOAD_GRAPH') {
        const { graph: loadedGraph, callsightConfig, mode: loadedMode } = message;
        setGraph(loadedGraph);
        setScanProgress(null);
        if (callsightConfig?.blacklist) {
          setBlacklist(callsightConfig.blacklist);
        }
        if (loadedMode) {
          setMode(loadedMode);
        }
      }
      if (message.type === 'GIT_STATUS') {
        setGitAvailable({ available: message.available, reason: message.reason });
      }
      if (message.type === 'DIFF_PROGRESS') {
        setDiffProgress(message.message);
      }
      if (message.type === 'DIFF_RESULT') {
        setDiffGraph(message.diffGraph);
        setIsDiffMode(true);
        setDiffLoading(false);
        setDiffProgress('');
        setDiffError(null);
      }
      if (message.type === 'DIFF_ERROR') {
        setDiffError(message.error);
        setDiffLoading(false);
        setDiffProgress('');
      }
      if (message.type === 'SCAN_PROGRESS') {
        setScanProgress({ scannedFiles: message.scannedFiles, totalFiles: message.totalFiles });
      }
    };

    window.addEventListener('message', handleMessage);
    
    // Tell extension we are ready to receive data
    window.vscode.postMessage({ type: 'READY' });
    // Check git availability
    window.vscode.postMessage({ type: 'CHECK_GIT_AVAILABLE' });

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const requestDiffCompare = (hashA: string, hashB: string) => {
    setDiffLoading(true);
    setDiffError(null);
    setDiffProgress('Starting comparison...');
    window.vscode.postMessage({
      type: 'REQUEST_DIFF_COMPARE',
      hashA: hashA.trim() || undefined,
      hashB: hashB.trim() || undefined,
    });
  };

  const exitDiffMode = () => {
    setIsDiffMode(false);
    setDiffGraph(null);
    setDiffError(null);
    setDiffProgress('');
  };

  // In diff mode, use diffGraph; otherwise use regular graph
  const activeGraph = isDiffMode && diffGraph ? diffGraph : graph;

  const isLargeGraph = activeGraph ? activeGraph.nodes.length > 500 : false;
  
  // Filter nodes by selected flows and/or focused node.
  // For large graphs with no selection, show nothing (user must pick a flow).
  // For small graphs with no selection, show everything.
  const displayGraph = React.useMemo(() => {
    if (!activeGraph) return null;

    const hasSelection = selectedFlows.size > 0 || focusedNodeId;

    // No selection: large graphs show empty, small graphs show full
    if (!hasSelection) {
      return isLargeGraph ? null : activeGraph;
    }

    const activeNodeIds = new Set<string>();

    if (selectedFlows.size > 0) {
      activeGraph.flows.forEach(f => {
        if (selectedFlows.has(f.id)) {
          f.nodeIds.forEach(id => activeNodeIds.add(id));
        }
      });
    }

    if (focusedNodeId) {
      activeNodeIds.add(focusedNodeId);
      activeGraph.edges.forEach(e => {
        if (e.from === focusedNodeId) activeNodeIds.add(e.to);
        if (e.to === focusedNodeId) activeNodeIds.add(e.from);
      });
    }

    const filteredNodes = activeGraph.nodes.filter(n => activeNodeIds.has(n.id));
    const filteredEdges = activeGraph.edges.filter(e => activeNodeIds.has(e.from) && activeNodeIds.has(e.to));
    const filteredFlows = activeGraph.flows.filter(f => selectedFlows.has(f.id));

    return { ...activeGraph, nodes: filteredNodes, edges: filteredEdges, flows: filteredFlows };
  }, [activeGraph, isLargeGraph, selectedFlows, focusedNodeId]);

  if (!activeGraph) {
    return (
      <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--vscode-editor-foreground)', flexDirection: 'column', gap: '8px' }}>
        <GraphLoader
          message="Scanning codebase..."
          submessage={scanProgress ? `Scanned ${scanProgress.scannedFiles} / ${scanProgress.totalFiles} files` : undefined}
        />
      </div>
    );
  }

  if (activeGraph.nodes.length === 0 && !isDiffMode) {
    return (
      <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--vscode-editor-foreground)' }}>
        <p>No functions found in this analysis.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', backgroundColor: 'var(--vscode-editor-background)' }}>
      <Sidebar 
        graph={activeGraph} 
        searchQuery={searchQuery} 
        onSearchChange={setSearchQuery}
        analysisState={analysisState}
        setAnalysisState={setAnalysisState}
        selectedFlows={selectedFlows}
        setSelectedFlows={setSelectedFlows}
        blacklist={blacklist}
        setBlacklist={setBlacklist}
        isLargeGraph={isLargeGraph}
        focusedNodeId={focusedNodeId}
        setFocusedNodeId={setFocusedNodeId}
        isDiffMode={isDiffMode}
        diffLoading={diffLoading}
        diffProgress={diffProgress}
        diffError={diffError}
        gitAvailable={gitAvailable}
        onRequestDiffCompare={requestDiffCompare}
        onExitDiffMode={exitDiffMode}
        diffGraph={diffGraph}
        mode={mode}
      />
      <div style={{ flex: 1, position: 'relative' }}>
        {/* Diff loading overlay */}
        {diffLoading && (
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20,
            background: 'rgba(0,0,0,0.95)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--vscode-editor-foreground)'
          }}>
            <GraphLoader
              message={diffProgress || 'Computing diff...'}
            />
          </div>
        )}

        {!isDiffMode && graph?.scannedFiles === 1 && !singleFileBannerDismissed && (
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, zIndex: 15,
            background: 'rgba(245, 158, 11, 0.15)',
            borderBottom: '1px solid rgba(245, 158, 11, 0.4)',
            color: '#fbbf24',
            padding: '8px 16px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            fontSize: '13px',
            backdropFilter: 'blur(8px)',
          }}>
            <span style={{ lineHeight: 1.4 }}>
              ⚠ Single file scan — entry points and call edges may be incomplete. Functions that only call external code will appear as orphans. Use 'Visualize Entire Workspace' for accurate results.
            </span>
            <button
              onClick={() => setSingleFileBannerDismissed(true)}
              style={{
                background: 'none', border: 'none', color: '#fbbf24', cursor: 'pointer',
                fontSize: '16px', padding: '2px 6px', marginLeft: '12px', flexShrink: 0,
              }}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        {!displayGraph && isLargeGraph && (
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 10, color: 'var(--vscode-editor-foreground)', textAlign: 'center' }}>
            <h2>Large Codebase Detected ({activeGraph.nodes.length} nodes)</h2>
            <p>Please select one or more flows from the sidebar to render the graph.</p>
          </div>
        )}
        {displayGraph && (
          <FlowCanvas 
            graph={displayGraph} 
            searchQuery={searchQuery} 
            analysisState={analysisState}
            focusedNodeId={focusedNodeId}
            setFocusedNodeId={setFocusedNodeId}
            isDiffMode={isDiffMode}
            diffGraph={isDiffMode ? diffGraph : null}
          />
        )}
        {/* Function focus hint */}
        {focusedNodeId && !focusHintDismissed && (
          <div style={{
            position: 'absolute', bottom: 16, right: 16, zIndex: 10,
            maxWidth: '280px',
            background: 'rgba(30, 41, 59, 0.92)',
            border: '1px solid rgba(148, 163, 184, 0.2)',
            borderRadius: '6px',
            padding: '10px 12px',
            backdropFilter: 'blur(8px)',
            color: 'var(--vscode-editor-foreground)',
            fontSize: '12px',
            lineHeight: '1.5',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}>
            <span style={{ opacity: 0.8 }}>
              Showing the selected function and its direct callers &amp; callees. Other nodes are faded. Faded edges connect nodes outside this context.
            </span>
            <button
              onClick={() => setFocusHintDismissed(true)}
              style={{
                background: 'none', border: 'none', color: 'var(--vscode-editor-foreground)',
                cursor: 'pointer', fontSize: '14px', padding: '0', flexShrink: 0, opacity: 0.6, lineHeight: 1,
              }}
              aria-label="Dismiss"
            >✕</button>
          </div>
        )}
      </div>
    </div>
  );
}
