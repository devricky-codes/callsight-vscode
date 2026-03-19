import React, { useState, useMemo } from 'react';
import { Graph, DiffGraph } from '@codeflow-map/core';
import { GraphAnalysisState } from '../App';

type SidebarTab = 'analysis' | 'flows' | 'functions';

interface SidebarProps {
  graph: Graph;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  analysisState: GraphAnalysisState;
  setAnalysisState: React.Dispatch<React.SetStateAction<GraphAnalysisState>>;
  selectedFlows: Set<string>;
  setSelectedFlows: React.Dispatch<React.SetStateAction<Set<string>>>;
  blacklist: string[];
  setBlacklist: React.Dispatch<React.SetStateAction<string[]>>;
  isLargeGraph: boolean;
  focusedNodeId: string | null;
  setFocusedNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  isDiffMode: boolean;
  diffLoading: boolean;
  diffProgress: string;
  diffError: string | null;
  gitAvailable: { available: boolean; reason?: string };
  onRequestDiffCompare: (hashA: string, hashB: string) => void;
  onExitDiffMode: () => void;
  diffGraph: DiffGraph | null;
  mode: 'workspace' | 'file';
}

export default function Sidebar({ graph, searchQuery, onSearchChange, analysisState, setAnalysisState, selectedFlows, setSelectedFlows, blacklist, setBlacklist, isLargeGraph, focusedNodeId, setFocusedNodeId, isDiffMode, diffLoading, diffProgress, diffError, gitAvailable, onRequestDiffCompare, onExitDiffMode, diffGraph, mode }: SidebarProps) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('analysis');
  const [localBlacklist, setLocalBlacklist] = useState(blacklist.join('\n'));
  const [flowSearch, setFlowSearch] = useState('');
  const [functionSearch, setFunctionSearch] = useState('');
  const [diffHashA, setDiffHashA] = useState('');
  const [diffHashB, setDiffHashB] = useState('');
  const [multiSelectFlows, setMultiSelectFlows] = useState(false);
  const [multiSelectFunctions, setMultiSelectFunctions] = useState(false);
  const [sortFlowsAlpha, setSortFlowsAlpha] = useState(false);
  const [sortFunctionsAlpha, setSortFunctionsAlpha] = useState(false);

  React.useEffect(() => {
    setLocalBlacklist(blacklist.join('\n'));
  }, [blacklist]);

  const uniqueNodes = Array.from(new Map(graph.nodes.map((n: any) => [n.id, n])).values());

  // Edge count per node for "connected nodes" display
  const connectedCount = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of graph.edges) {
      if (e.from !== e.to) {
        counts[e.from] = (counts[e.from] || 0) + 1;
        counts[e.to] = (counts[e.to] || 0) + 1;
      }
    }
    return counts;
  }, [graph.edges]);

  const toggleFeature = (key: keyof GraphAnalysisState) => {
    setAnalysisState(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleFlow = (flowId: string) => {
    // Clear any function selection when selecting a workflow
    setFocusedNodeId(null);
    if (multiSelectFlows) {
      setSelectedFlows(prev => {
        const next = new Set(prev);
        if (next.has(flowId)) next.delete(flowId);
        else next.add(flowId);
        return next;
      });
    } else {
      setSelectedFlows(prev => prev.has(flowId) && prev.size === 1 ? new Set() : new Set([flowId]));
    }
  };

  const toggleFunction = (nodeId: string) => {
    // Clear any workflow selection when selecting a function
    if (selectedFlows.size > 0) {
      setSelectedFlows(new Set());
    }
    if (multiSelectFunctions) {
      setFocusedNodeId(prev => prev === nodeId ? null : nodeId);
    } else {
      setFocusedNodeId(prev => prev === nodeId ? null : nodeId);
    }
  };

  const applyBlacklist = () => {
    const list = localBlacklist.split('\n').map(s => s.trim()).filter(s => s);
    setBlacklist(list);
    window.vscode.postMessage({ type: 'UPDATE_BLACKLIST', blacklist: list });
  };

  const uniqueFlows = Array.from(new Map(graph.flows.map((f: any) => [f.id, f])).values());

  // In diff mode, determine which nodes are diff-affected (not 'unchanged')
  const diffAffectedNodeIds = useMemo(() => {
    if (!isDiffMode || !diffGraph) return null;
    const ids = new Set<string>();
    for (const [id, status] of Object.entries(diffGraph.nodeDiffStatus)) {
      if (status !== 'unchanged') ids.add(id);
    }
    return ids;
  }, [isDiffMode, diffGraph]);

  const diffAffectedEdgeIds = useMemo(() => {
    if (!isDiffMode || !diffGraph) return null;
    const ids = new Set<string>();
    for (const [id, status] of Object.entries(diffGraph.edgeDiffStatus)) {
      if (status !== 'unchanged') ids.add(id);
    }
    return ids;
  }, [isDiffMode, diffGraph]);

  // Filtered flows by search (and diff mode)
  const filteredFlows = useMemo(() => {
    let flows = uniqueFlows;
    // In diff mode, keep only flows with at least one diff-affected node or edge
    if (diffAffectedNodeIds) {
      flows = flows.filter((f: any) => {
        const hasAffectedNode = f.nodeIds.some((nid: string) => diffAffectedNodeIds.has(nid));
        if (hasAffectedNode) return true;
        // Also check edges within this flow
        if (diffAffectedEdgeIds) {
          const nodeSet = new Set<string>(f.nodeIds);
          return graph.edges.some((e: any) => nodeSet.has(e.from) && nodeSet.has(e.to) && diffAffectedEdgeIds.has(`${e.from}->${e.to}`));
        }
        return false;
      });
    }
    if (flowSearch) {
      const q = flowSearch.toLowerCase();
      flows = flows.filter((f: any) => {
        const entryName = f.entryPoint ? graph.nodes.find((n: any) => n.id === f.entryPoint)?.name || '' : '';
        return entryName.toLowerCase().includes(q) || f.id.toLowerCase().includes(q);
      });
    }
    // Sort: alphabetical or by node count (desc)
    if (sortFlowsAlpha) {
      flows = [...flows].sort((a: any, b: any) => {
        const nameA = a.entryPoint ? graph.nodes.find((n: any) => n.id === a.entryPoint)?.name || '' : '';
        const nameB = b.entryPoint ? graph.nodes.find((n: any) => n.id === b.entryPoint)?.name || '' : '';
        return nameA.localeCompare(nameB);
      });
    } else {
      flows = [...flows].sort((a: any, b: any) => b.nodeIds.length - a.nodeIds.length);
    }
    return flows;
  }, [uniqueFlows, flowSearch, graph.nodes, graph.edges, diffAffectedNodeIds, diffAffectedEdgeIds, sortFlowsAlpha]);

  // Filtered functions by search (and diff mode)
  const filteredNodes = useMemo(() => {
    let nodes = uniqueNodes;
    // In diff mode, keep only nodes with diff status != 'unchanged'
    if (diffAffectedNodeIds) {
      nodes = nodes.filter((n: any) => diffAffectedNodeIds.has(n.id));
    }
    const q = functionSearch.toLowerCase();
    if (q) {
      nodes = nodes.filter((n: any) => n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q));
    }
    // Sort: alphabetical or by connection count (desc)
    if (sortFunctionsAlpha) {
      nodes = [...nodes].sort((a: any, b: any) => a.name.localeCompare(b.name));
    } else {
      nodes = [...nodes].sort((a: any, b: any) => (connectedCount[b.id] || 0) - (connectedCount[a.id] || 0));
    }
    return nodes;
  }, [uniqueNodes, functionSearch, diffAffectedNodeIds, sortFunctionsAlpha, connectedCount]);

  // Orphan nodes resolved from IDs
  const orphanNodes = useMemo(() => {
    const orphanSet = new Set(graph.orphans || []);
    return uniqueNodes.filter((n: any) => orphanSet.has(n.id));
  }, [graph.orphans, uniqueNodes]);

  // Also propagate the function search to the global search used by FlowCanvas
  const handleFunctionSearch = (val: string) => {
    setFunctionSearch(val);
    onSearchChange(val);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '6px 8px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: '2px',
    outline: 'none',
    boxSizing: 'border-box',
    marginBottom: '12px'
  };

  const diffLegend = isDiffMode ? (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px', padding: '6px 8px', background: 'var(--vscode-list-inactiveSelectionBackground)', borderRadius: '4px', fontSize: '11px' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />Added</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />Removed</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />Changed</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#94a3b8', display: 'inline-block' }} />Unchanged</span>
    </div>
  ) : null;

  return (
    <div style={{
      width: '280px',
      background: 'var(--vscode-sideBar-background)',
      borderRight: '1px solid var(--vscode-sideBar-border)',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      color: 'var(--vscode-sideBar-foreground)'
    }}>
      {/* Header */}
      <div style={{ padding: '12px 16px 0', borderBottom: '1px solid var(--vscode-sideBarSectionHeader-border)' }}>
        <h2 style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px', margin: '0 0 10px 0', color: 'var(--vscode-sideBarTitle-foreground)' }}>CallSight</h2>
        {/* Tabs */}
        <div className="sidebar-tabs">
          {(['analysis', 'flows', 'functions'] as SidebarTab[]).map(tab => (
            <button
              key={tab}
              className={`sidebar-tab ${activeTab === tab ? 'sidebar-tab--active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>

        {/* ── Analysis Tab ── */}
        {activeTab === 'analysis' && (
          <>
            {mode === 'file' ? (
              <div style={{ marginBottom: '24px' }}>
                <h3 style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', margin: '0 0 8px 0', color: 'var(--vscode-sideBarTitle-foreground)' }}>
                  Current File
                </h3>
                <button
                  onClick={() => window.vscode.postMessage({ type: 'REFRESH_CURRENT_FILE' })}
                  style={{ width: '100%', padding: '4px 0', background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none', borderRadius: '2px', cursor: 'pointer' }}
                >
                  Refresh
                </button>
              </div>
            ) : (
              <div style={{ marginBottom: '24px' }}>
                <h3 style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', margin: '0 0 8px 0', color: 'var(--vscode-sideBarTitle-foreground)' }}>
                  Ignore / Blacklist Patterns
                </h3>
                <textarea
                  value={localBlacklist}
                  onChange={e => setLocalBlacklist(e.target.value)}
                  placeholder="Glob patterns (one per line)..."
                  style={{
                    width: '100%',
                    minHeight: '60px',
                    padding: '6px 8px',
                    background: 'var(--vscode-input-background)',
                    color: 'var(--vscode-input-foreground)',
                    border: '1px solid var(--vscode-input-border)',
                    borderRadius: '2px',
                    resize: 'vertical',
                    boxSizing: 'border-box',
                    marginBottom: '4px'
                  }}
                />
                <button
                  onClick={applyBlacklist}
                  style={{ width: '100%', padding: '4px 0', background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none', borderRadius: '2px', cursor: 'pointer' }}
                >
                  Apply &amp; Re-analyze
                </button>
              </div>
            )}

            <div style={{ marginBottom: '24px' }}>
              <h3 style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', margin: '0 0 8px 0', color: 'var(--vscode-sideBarTitle-foreground)' }}>
                Graph Analysis
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={analysisState.heatmap} onChange={() => toggleFeature('heatmap')} />
                  Coupling Heatmap
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={analysisState.impactRadius} onChange={() => toggleFeature('impactRadius')} />
                  Impact Radius Focus
                </label>
                {analysisState.impactRadius && (
                  <div style={{ marginLeft: '24px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                    <span>Depth:</span>
                    <button
                      onClick={() => setAnalysisState(prev => ({ ...prev, impactDepth: Math.max(1, prev.impactDepth - 1) }))}
                      style={{ width: '22px', height: '22px', background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)', border: 'none', borderRadius: '3px', cursor: 'pointer', fontWeight: 'bold', fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >−</button>
                    <span style={{ minWidth: '16px', textAlign: 'center', fontWeight: 600 }}>{analysisState.impactDepth}</span>
                    <button
                      onClick={() => setAnalysisState(prev => ({ ...prev, impactDepth: prev.impactDepth + 1 }))}
                      style={{ width: '22px', height: '22px', background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)', border: 'none', borderRadius: '3px', cursor: 'pointer', fontWeight: 'bold', fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >+</button>
                  </div>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={analysisState.circularDependency} onChange={() => toggleFeature('circularDependency')} />
                  Circular Dependencies
                </label>
                {analysisState.circularDependency && (
                  <div style={{ marginLeft: '24px', fontSize: '11px', opacity: 0.6, fontStyle: 'italic' }}>
                    Cycles detected within visible flows only
                  </div>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={analysisState.complexityGlow} onChange={() => toggleFeature('complexityGlow')} />
                  Complexity Glow
                </label>
                {analysisState.complexityGlow && (
                  <div style={{ marginLeft: '24px', fontSize: '11px', opacity: 0.5, fontStyle: 'italic' }}>
                    Cyclomatic Complexity
                  </div>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={analysisState.moduleClustering} onChange={() => toggleFeature('moduleClustering')} />
                  Module Clusters
                </label>
              </div>
            </div>

            {/* Git Diff Compare */}
            <div style={{ marginBottom: '24px' }}>
              <h3 style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', margin: '0 0 8px 0', color: 'var(--vscode-sideBarTitle-foreground)' }}>
                Git Diff Compare
              </h3>

              {isDiffMode && (
                <button
                  onClick={onExitDiffMode}
                  style={{
                    width: '100%', padding: '6px 0', marginBottom: '8px',
                    background: '#ef4444', color: '#fff', border: 'none', borderRadius: '2px', cursor: 'pointer',
                    fontWeight: 600, fontSize: '12px'
                  }}
                >
                  Exit Diff Mode
                </button>
              )}

              <input
                type="text"
                placeholder="Commit hash A (optional)"
                value={diffHashA}
                onChange={e => setDiffHashA(e.target.value)}
                disabled={diffLoading}
                style={{
                  ...inputStyle,
                  marginBottom: '4px',
                  fontFamily: 'var(--vscode-editor-font-family)',
                  fontSize: '12px'
                }}
              />
              <input
                type="text"
                placeholder="Commit hash B (optional)"
                value={diffHashB}
                onChange={e => setDiffHashB(e.target.value)}
                disabled={diffLoading}
                style={{
                  ...inputStyle,
                  marginBottom: '4px',
                  fontFamily: 'var(--vscode-editor-font-family)',
                  fontSize: '12px'
                }}
              />

              <div style={{ fontSize: '10px', opacity: 0.6, marginBottom: '8px', lineHeight: '1.4' }}>
                {!diffHashA && !diffHashB && 'Empty = uncommitted changes vs HEAD'}
                {diffHashA && !diffHashB && 'One hash = compare hash A vs HEAD'}
                {diffHashA && diffHashB && 'Two hashes = compare A vs B'}
                {!diffHashA && diffHashB && 'Tip: put the older commit in hash A'}
              </div>

              <button
                onClick={() => onRequestDiffCompare(diffHashA, diffHashB)}
                disabled={!gitAvailable.available || diffLoading}
                title={!gitAvailable.available ? gitAvailable.reason : diffLoading ? 'Comparison in progress...' : 'Run git diff comparison'}
                style={{
                  width: '100%', padding: '6px 0',
                  background: (!gitAvailable.available || diffLoading) ? 'var(--vscode-button-secondaryBackground)' : 'var(--vscode-button-background)',
                  color: (!gitAvailable.available || diffLoading) ? 'var(--vscode-button-secondaryForeground)' : 'var(--vscode-button-foreground)',
                  border: 'none', borderRadius: '2px',
                  cursor: (!gitAvailable.available || diffLoading) ? 'not-allowed' : 'pointer',
                  opacity: (!gitAvailable.available || diffLoading) ? 0.6 : 1,
                  fontWeight: 600, fontSize: '12px'
                }}
              >
                {diffLoading ? 'Comparing...' : 'Compare'}
              </button>
              <div style={{ fontSize: '10px', opacity: 0.45, marginTop: '6px', fontStyle: 'italic' }}>
                Only workflows and functions with diff are listed
              </div>

              {diffLoading && diffProgress && (
                <div style={{ fontSize: '11px', marginTop: '6px', opacity: 0.8, color: 'var(--vscode-textLink-foreground)' }}>
                  {diffProgress}
                </div>
              )}

              {diffError && (
                <div style={{ fontSize: '11px', marginTop: '6px', color: '#ef4444', wordBreak: 'break-word' }}>
                  {diffError}
                </div>
              )}

              {!gitAvailable.available && (
                <div style={{ fontSize: '11px', marginTop: '6px', opacity: 0.6, color: '#f59e0b' }}>
                  {gitAvailable.reason}
                </div>
              )}
            </div>

            {/* Export Graph */}
            <div style={{ marginBottom: '24px' }}>
              <h3 style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', margin: '0 0 8px 0', color: 'var(--vscode-sideBarTitle-foreground)' }}>
                Export
              </h3>
              <button
                onClick={() => window.vscode.postMessage({ type: 'EXPORT_GRAPH_JSON', graph })}
                style={{
                  width: '100%', padding: '6px 0',
                  background: 'var(--vscode-button-background)',
                  color: 'var(--vscode-button-foreground)',
                  border: 'none', borderRadius: '2px',
                  cursor: 'pointer', fontWeight: 600, fontSize: '12px'
                }}
              >
                Export Graph as JSON
              </button>
            </div>
          </>
        )}

        {/* ── Flows Tab ── */}
        {activeTab === 'flows' && (
          <>
            <input
              type="text"
              placeholder="Search flows..."
              value={flowSearch}
              onChange={e => setFlowSearch(e.target.value)}
              style={inputStyle}
            />
            {diffLegend}

            <h3 style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', margin: '0 0 4px 0', color: 'var(--vscode-sideBarTitle-foreground)' }}>
              Detected Flows {isLargeGraph && '(Select to Render)'}
            </h3>
            <div style={{ fontSize: '11px', opacity: 0.6, marginBottom: '8px' }}>{filteredFlows.length} flows</div>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={() => { setSelectedFlows(new Set()); setFocusedNodeId(null); }}
                disabled={selectedFlows.size === 0}
                style={{
                  padding: '3px 8px', fontSize: '11px',
                  background: 'var(--vscode-button-secondaryBackground)',
                  color: 'var(--vscode-button-secondaryForeground)',
                  border: 'none', borderRadius: '2px',
                  cursor: selectedFlows.size === 0 ? 'default' : 'pointer',
                  opacity: selectedFlows.size === 0 ? 0.5 : 1
                }}
              >
                Clear All
              </button>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', cursor: 'pointer' }}>
                <input type="checkbox" checked={sortFlowsAlpha} onChange={() => setSortFlowsAlpha(v => !v)} style={{ margin: 0 }} />
                A-Z
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', cursor: 'pointer', marginLeft: 'auto' }}>
                <input type="checkbox" checked={multiSelectFlows} onChange={() => setMultiSelectFlows(v => !v)} style={{ margin: 0 }} />
                Multi
              </label>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '24px' }}>
              {filteredFlows.map((f: any) => {
                const entryNode = f.entryPoint ? graph.nodes.find((n: any) => n.id === f.entryPoint) : null;
                const entryName = entryNode?.name || 'Disconnected Flow';
                const isSelected = selectedFlows.has(f.id);
                return (
                  <div
                    key={f.id}
                    onClick={() => toggleFlow(f.id)}
                    className="sidebar-list-item"
                    style={{
                      padding: '8px 10px',
                      background: isSelected ? 'var(--vscode-list-activeSelectionBackground)' : 'var(--vscode-list-inactiveSelectionBackground)',
                      color: isSelected ? 'var(--vscode-list-activeSelectionForeground)' : 'inherit',
                      border: isSelected ? '1px solid var(--vscode-focusBorder)' : '1px solid transparent',
                      borderRadius: '4px',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontWeight: 500, fontSize: '13px', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{entryName}</div>
                    <div style={{ fontSize: '10px', opacity: 0.5, marginTop: '2px', fontFamily: 'var(--vscode-editor-font-family)', wordBreak: 'break-all' }}>{f.id}</div>
                    <div style={{ fontSize: '11px', opacity: 0.7, marginTop: '2px' }}>{f.nodeIds.length} connected nodes</div>
                  </div>
                );
              })}
            </div>

            {orphanNodes.length > 0 && (
              <>
                <h3 style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', margin: '0 0 8px 0', color: 'var(--vscode-sideBarTitle-foreground)' }}>
                  Orphan Candidates ({orphanNodes.length})
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  {orphanNodes.map((n: any) => (
                    <div
                      key={n.id}
                      style={{
                        padding: '6px 10px',
                        fontSize: '12px',
                        opacity: 0.6,
                        borderRadius: '4px',
                        background: 'var(--vscode-list-inactiveSelectionBackground)',
                      }}
                    >
                      <div style={{ fontWeight: 500 }}>{n.name}</div>
                      <div style={{ fontSize: '10px', opacity: 0.5, marginTop: '2px', fontFamily: 'var(--vscode-editor-font-family)', wordBreak: 'break-all' }}>{n.id}</div>
                      <div style={{ fontSize: '11px', opacity: 0.7, marginTop: '2px' }}>0 connections</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {/* ── Functions Tab ── */}
        {activeTab === 'functions' && (
          <>
            <input
              type="text"
              placeholder="Search functions..."
              value={functionSearch}
              onChange={e => handleFunctionSearch(e.target.value)}
              style={inputStyle}
            />
            {diffLegend}

            <h3 style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', margin: '0 0 4px 0', color: 'var(--vscode-sideBarTitle-foreground)' }}>
              Functions
            </h3>
            <div style={{ fontSize: '11px', opacity: 0.6, marginBottom: '8px' }}>{filteredNodes.length} functions</div>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={() => setFocusedNodeId(null)}
                disabled={!focusedNodeId}
                style={{
                  padding: '3px 8px', fontSize: '11px',
                  background: 'var(--vscode-button-secondaryBackground)',
                  color: 'var(--vscode-button-secondaryForeground)',
                  border: 'none', borderRadius: '2px',
                  cursor: !focusedNodeId ? 'default' : 'pointer',
                  opacity: !focusedNodeId ? 0.5 : 1
                }}
              >
                Clear Selection
              </button>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', cursor: 'pointer' }}>
                <input type="checkbox" checked={sortFunctionsAlpha} onChange={() => setSortFunctionsAlpha(v => !v)} style={{ margin: 0 }} />
                A-Z
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', cursor: 'pointer', marginLeft: 'auto' }}>
                <input type="checkbox" checked={multiSelectFunctions} onChange={() => setMultiSelectFunctions(v => !v)} style={{ margin: 0 }} />
                Multi
              </label>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {filteredNodes.map((n: any) => (
                <div
                  key={n.id}
                  className="sidebar-list-item"
                  style={{
                    padding: '8px 10px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    background: focusedNodeId === n.id ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent',
                    color: focusedNodeId === n.id ? 'var(--vscode-list-activeSelectionForeground)' : 'inherit',
                  }}
                  onClick={() => toggleFunction(n.id)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 500, fontSize: '13px', fontFamily: 'var(--vscode-editor-font-family)', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{n.name}</span>
                    {n.isEntryPoint && <span style={{ fontSize: '10px', color: 'var(--vscode-testing-iconPassed)' }}>ENTRY</span>}
                  </div>
                  <div style={{ fontSize: '10px', opacity: 0.5, marginTop: '2px', fontFamily: 'var(--vscode-editor-font-family)', wordBreak: 'break-all' }}>{n.id}</div>
                  <div style={{ fontSize: '11px', opacity: 0.7, marginTop: '2px' }}>{connectedCount[n.id] || 0} connections</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
