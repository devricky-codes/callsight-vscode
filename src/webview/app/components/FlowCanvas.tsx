import React, { useMemo, useEffect, useState, useCallback, useRef } from 'react';
import { 
  ReactFlow, 
  Controls, 
  Background, 
  Node, 
  Edge, 
  BackgroundVariant,
  useNodesState,
  useEdgesState
} from '@xyflow/react';
import dagre from 'dagre';
import { Graph, DiffGraph } from '@codeflow-map/core';
import FunctionNode from './FunctionNode';
import Minimap from './Minimap';
import { GraphAnalysisState } from '../App';

const nodeTypes = { functionNode: FunctionNode };

const getLayoutedElements = (graph: Graph, direction = 'LR') => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  const nodeWidth = 280;
  const nodeHeight = 120;

  dagreGraph.setGraph({ rankdir: direction, nodesep: 60, ranksep: 120 });

  const rawNodes: Node[] = graph.nodes.map((n: any) => ({
    id: n.id,
    type: 'functionNode',
    data: n,
    position: { x: 0, y: 0 }
  }));

  const rawEdges: Edge[] = graph.edges.map((e: any, idx: number) => ({
    id: `e${idx}-${e.from}-${e.to}`,
    source: e.from,
    target: e.to,
    animated: true,
    style: { stroke: '#94a3b8', strokeWidth: 2 }
  }));

  rawNodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  rawEdges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = rawNodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - nodeWidth / 2,
        y: nodeWithPosition.y - nodeHeight / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges: rawEdges };
};

// ─── Analysis Helpers ────────────────────────────────────────

/** Compute degree (in + out) for every node */
function computeDegreeMap(graph: Graph): Map<string, number> {
  const deg = new Map<string, number>();
  for (const n of graph.nodes) deg.set(n.id, 0);
  for (const e of graph.edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to,   (deg.get(e.to)   ?? 0) + 1);
  }
  return deg;
}

/** Map a degree value to a heatmap colour (blue→yellow→red) */
function degreeToColor(degree: number, maxDegree: number): string {
  if (maxDegree <= 0) return 'rgba(56, 189, 248, 0.3)'; // cyan fallback
  const t = Math.min(degree / maxDegree, 1);
  // blue(0) → yellow(0.5) → red(1)
  if (t < 0.5) {
    const u = t * 2;
    const r = Math.round(59  + u * (234 - 59));
    const g = Math.round(130 + u * (179 - 130));
    const b = Math.round(246 - u * 246);
    return `rgba(${r},${g},${b},0.55)`;
  } else {
    const u = (t - 0.5) * 2;
    const r = Math.round(234 + u * (239 - 234));
    const g = Math.round(179 - u * 179);
    return `rgba(${r},${g},30,0.55)`;
  }
}

/** BFS from a start node up to a given depth */
function bfs(startId: string, graph: Graph, maxDepth: number): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const adj = new Map<string, { neighborId: string; edgeIdx: number }[]>();
  graph.edges.forEach((e: any, idx: number) => {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to))   adj.set(e.to,   []);
    adj.get(e.from)!.push({ neighborId: e.to,   edgeIdx: idx });
    adj.get(e.to)!  .push({ neighborId: e.from, edgeIdx: idx });
  });

  const visited = new Set<string>([startId]);
  const edgeIds = new Set<string>();
  let frontier = [startId];

  for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
    const nextFrontier: string[] = [];
    for (const nid of frontier) {
      for (const { neighborId, edgeIdx } of (adj.get(nid) ?? [])) {
        const e = graph.edges[edgeIdx];
        edgeIds.add(`e${edgeIdx}-${e.from}-${e.to}`);
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          nextFrontier.push(neighborId);
        }
      }
    }
    frontier = nextFrontier;
  }
  return { nodeIds: visited, edgeIds };
}

/** DFS-based cycle detection – returns set of node IDs involved in cycles */
function detectCycles(graph: Graph): { cycleNodeIds: Set<string>; cycleEdgeIds: Set<string> } {
  const adj = new Map<string, { to: string; edgeIdx: number }[]>();
  graph.edges.forEach((e: any, idx: number) => {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push({ to: e.to, edgeIdx: idx });
  });

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const n of graph.nodes) color.set(n.id, WHITE);

  const cycleNodeIds = new Set<string>();
  const cycleEdgeIds = new Set<string>();
  const parent = new Map<string, string | null>();

  function dfs(u: string) {
    color.set(u, GRAY);
    for (const { to: v, edgeIdx } of (adj.get(u) ?? [])) {
      if (color.get(v) === GRAY) {
        // Skip self-recursive calls – only flag cycles with 2+ distinct functions
        if (u === v) continue;
        // back-edge found → cycle
        const e = graph.edges[edgeIdx];
        cycleEdgeIds.add(`e${edgeIdx}-${e.from}-${e.to}`);
        cycleNodeIds.add(u);
        cycleNodeIds.add(v);
        // trace back
        let cur = u;
        while (cur && cur !== v) {
          cycleNodeIds.add(cur);
          cur = parent.get(cur) ?? '';
        }
      } else if (color.get(v) === WHITE) {
        parent.set(v, u);
        dfs(v);
      }
    }
    color.set(u, BLACK);
  }

  for (const n of graph.nodes) {
    if (color.get(n.id) === WHITE) dfs(n.id);
  }
  return { cycleNodeIds, cycleEdgeIds };
}

/** Compute complexity score based on line count */
function computeComplexityMap(graph: Graph): Map<string, number> {
  const map = new Map<string, number>();
  let maxLines = 1;
  for (const n of graph.nodes) {
    const lines = n.endLine - n.startLine + 1;
    map.set(n.id, lines);
    if (lines > maxLines) maxLines = lines;
  }
  // normalize 0–1
  for (const [id, lines] of map) {
    map.set(id, lines / maxLines);
  }
  return map;
}

/** Simple module clustering: group by file, then find cross-file connected components */
function computeModuleClusters(graph: Graph): Map<string, number> {
  // UF (Union-Find)
  const parent = new Map<string, string>();
  for (const n of graph.nodes) parent.set(n.id, n.id);
  function find(x: string): string {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; }
    return x;
  }
  function union(a: string, b: string) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // union nodes connected by cross-file edges
  const nodeFileMap = new Map<string, string>();
  for (const n of graph.nodes) nodeFileMap.set(n.id, n.filePath);

  for (const e of graph.edges) {
    const fileA = nodeFileMap.get(e.from);
    const fileB = nodeFileMap.get(e.to);
    if (fileA && fileB && fileA !== fileB) {
      union(e.from, e.to);
    }
  }

  // assign cluster index
  const rootToCluster = new Map<string, number>();
  const nodeCluster = new Map<string, number>();
  let clusterIdx = 0;
  for (const n of graph.nodes) {
    const root = find(n.id);
    if (!rootToCluster.has(root)) {
      rootToCluster.set(root, clusterIdx++);
    }
    nodeCluster.set(n.id, rootToCluster.get(root)!);
  }
  return nodeCluster;
}

const CLUSTER_NODE_COLORS = [
  '#38bdf8',  // cyan
  '#fb923c',  // orange
  '#a78bfa',  // purple
  '#34d399',  // emerald
  '#fbbf24',  // amber
  '#f472b6',  // pink
  '#818cf8',  // indigo
  '#14b8a6',  // teal
];

// ─── Component ────────────────────────────────────────

interface FlowCanvasProps {
  graph: Graph;
  searchQuery: string;
  analysisState: GraphAnalysisState;
  focusedNodeId: string | null;
  setFocusedNodeId: (id: string | null) => void;
  isDiffMode: boolean;
  diffGraph: DiffGraph | null;
}

export default function FlowCanvas({ graph, searchQuery, analysisState, focusedNodeId, setFocusedNodeId, isDiffMode, diffGraph }: FlowCanvasProps) {
  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => getLayoutedElements(graph), [graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const updateSearchQuery = useCallback((value: string) => {
    setLocalSearchQuery(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(value), 250);
  }, []);

  // Clean up timer on unmount
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const [reactFlowInstance, setReactFlowInstance] = useState<any>(null);
  const [rootDropdownOpen, setRootDropdownOpen] = useState(false);

  // Identify root nodes (entry points or nodes with no incoming edges) currently in the graph
  const rootNodes = useMemo(() => {
    const incomingTargets = new Set(graph.edges.map(e => e.to));
    const seen = new Set<string>();
    return graph.nodes.filter(n => {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      return n.isEntryPoint || !incomingTargets.has(n.id);
    });
  }, [graph]);

  const panToNode = useCallback((nodeId: string) => {
    if (!reactFlowInstance) return;
    const node = reactFlowInstance.getNode(nodeId);
    if (node) {
      const x = node.position.x + (node.width || 280) / 2;
      const y = node.position.y + (node.height || 120) / 2;
      reactFlowInstance.setCenter(x, y, { zoom: 1, duration: 800 });
    }
    setLocalSearchQuery('');
    setDebouncedSearch('');
    setRootDropdownOpen(false);
  }, [reactFlowInstance]);

  // Dropdown matches for isolate search — prefix match on name or file path
  const searchDropdownMatches = useMemo(() => {
    if (!debouncedSearch) return [];
    const q = debouncedSearch.toLowerCase();
    return graph.nodes.filter((n: any) =>
      n.name.toLowerCase().startsWith(q) ||
      (n.filePath && n.filePath.toLowerCase().startsWith(q))
    ).slice(0, 20);
  }, [debouncedSearch, graph.nodes]);

  // Re-layout on new graph data (but don't clear focus — that's user-driven)
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // Pan to focused node whenever it changes
  useEffect(() => {
    if (!focusedNodeId || !reactFlowInstance) return;
    // Use a short delay to let the layout settle before panning
    const timer = setTimeout(() => {
      const node = reactFlowInstance.getNode(focusedNodeId);
      if (node) {
        const x = node.position.x + (node.width || 280) / 2;
        const y = node.position.y + (node.height || 120) / 2;
        reactFlowInstance.setCenter(x, y, { zoom: 1, duration: 800 });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [focusedNodeId, reactFlowInstance, initialNodes]);

  // ─── Local Search Isolation ───────────
  const searchIsolatedResult = useMemo(() => {
    if (!debouncedSearch) return null;
    const lowerQuery = debouncedSearch.toLowerCase();
    
    // Find all nodes that match (prefix on name or filePath)
    const matchingNodeIds = nodes
      .filter((n: any) => {
        const name = typeof n.data?.name === 'string' ? n.data.name.toLowerCase() : '';
        const fp = typeof n.data?.filePath === 'string' ? n.data.filePath.toLowerCase() : '';
        return name.startsWith(lowerQuery) || fp.startsWith(lowerQuery);
      })
      .map((n: any) => n.id);
      
    if (matchingNodeIds.length === 0) return { nodeIds: new Set<string>(), edgeIds: new Set<string>() };
    
    const finalNodeIds = new Set<string>();
    const finalEdgeIds = new Set<string>();
    
    matchingNodeIds.forEach(startId => {
       const res = bfs(startId, graph, 1);
       res.nodeIds.forEach(id => finalNodeIds.add(id));
       res.edgeIds.forEach(id => finalEdgeIds.add(id));
    });
    
    return { nodeIds: finalNodeIds, edgeIds: finalEdgeIds };
  }, [debouncedSearch, nodes, graph]);

  // ─── Heatmap ────────────────────────────
  const degreeMap = useMemo(() => analysisState.heatmap ? computeDegreeMap(graph) : new Map(), [graph, analysisState.heatmap]);
  const maxDegree = useMemo(() => {
    let m = 0;
    degreeMap.forEach(v => { if (v > m) m = v; });
    return m;
  }, [degreeMap]);

  // ─── Impact Radius (BFS) ────────────
  const impactTargetId = analysisState.impactRadius ? (hoveredNodeId ?? focusedNodeId) : null;
  const impactResult = useMemo(() => {
    if (!impactTargetId) return null;
    return bfs(impactTargetId, graph, analysisState.impactDepth);
  }, [impactTargetId, analysisState.impactDepth, graph]);

  // ─── Circular Dependencies ─────────────
  const cycleResult = useMemo(() => analysisState.circularDependency ? detectCycles(graph) : null, [graph, analysisState.circularDependency]);

  // ─── Complexity Glow ───────────────────
  const complexityMap = useMemo(() => analysisState.complexityGlow ? computeComplexityMap(graph) : new Map(), [graph, analysisState.complexityGlow]);

  // ─── Module Clustering ─────────────────
  const clusterMap = useMemo(() => analysisState.moduleClustering ? computeModuleClusters(graph) : new Map(), [graph, analysisState.moduleClustering]);

  // ─── Focus (non-impact-radius) ─────
  const { connectedNodeIds, connectedEdgeIds } = useMemo(() => {
    if (!focusedNodeId || analysisState.impactRadius) return { connectedNodeIds: new Set(), connectedEdgeIds: new Set() };

    const nodeIds = new Set<string>([focusedNodeId]);
    const edgeIds = new Set<string>();

    graph.edges.forEach((e: any, idx: number) => {
      if (e.from === focusedNodeId || e.to === focusedNodeId) {
        nodeIds.add(e.from);
        nodeIds.add(e.to);
        edgeIds.add(`e${idx}-${e.from}-${e.to}`);
      }
    });

    return { connectedNodeIds: nodeIds, connectedEdgeIds: edgeIds };
  }, [focusedNodeId, graph.edges, analysisState.impactRadius]);

  // ─── Compute display nodes ─────────
  const displayNodes = useMemo(() => {
    // Check which clusters have >1 node (cross-file groups)
    const clusterCounts = new Map<number, number>();
    if (analysisState.moduleClustering) {
      clusterMap.forEach(cid => clusterCounts.set(cid, (clusterCounts.get(cid) ?? 0) + 1));
    }

    return nodes.map((node: Node<any>) => {
      let opacity = 1;
      
      // Impact radius on hover/focus
      if (impactTargetId && analysisState.impactRadius && impactResult) {
        opacity = impactResult.nodeIds.has(node.id) ? 1 : 0.15;
      } else if (focusedNodeId && !analysisState.impactRadius) {
        opacity = connectedNodeIds.has(node.id) ? 1 : 0.15;
      } 
      // Fallback to Search Highlight
      else if (searchQuery) {
        opacity = typeof node.data?.name === 'string' && node.data.name.toLowerCase().includes(searchQuery.toLowerCase()) ? 1 : 0.15;
      }

      // Heatmap: override border color
      let analysisOverrides: any = {};
      if (analysisState.heatmap) {
        const deg = degreeMap.get(node.id) ?? 0;
        analysisOverrides.borderColor = degreeToColor(deg, maxDegree);
        analysisOverrides.borderTopColor = degreeToColor(deg, maxDegree);
      }

      // Circular dependency highlight — emphasise cycle nodes, dim others
      if (cycleResult) {
        if (cycleResult.cycleNodeIds.has(node.id)) {
          analysisOverrides.borderColor = '#ef4444';
          analysisOverrides.borderTopColor = '#ef4444';
          analysisOverrides.boxShadow = '0 0 12px rgba(239, 68, 68, 0.6)';
        } else {
          opacity = 0.15;
        }
      }

      // Complexity glow
      if (analysisState.complexityGlow) {
        const intensity = complexityMap.get(node.id) ?? 0;
        const spread = Math.round(4 + intensity * 20);
        const alpha = (0.1 + intensity * 0.5).toFixed(2);
        const existing = analysisOverrides.boxShadow ?? '';
        const glowShadow = `0 0 ${spread}px rgba(251, 191, 36, ${alpha})`;
        analysisOverrides.boxShadow = existing ? `${existing}, ${glowShadow}` : glowShadow;
      }

      // Module clustering: tint node background with unique cluster color
      if (analysisState.moduleClustering) {
        const cid = clusterMap.get(node.id);
        if (cid !== undefined && (clusterCounts.get(cid) ?? 0) > 1) {
          const clusterColor = CLUSTER_NODE_COLORS[cid % CLUSTER_NODE_COLORS.length];
          analysisOverrides.backgroundColor = clusterColor;
        }
      }

      let hidden = false;
      if (searchIsolatedResult && !searchIsolatedResult.nodeIds.has(node.id)) {
        hidden = true;
      }

      // Diff status for this node
      const diffStatus = (isDiffMode && diffGraph) ? diffGraph.nodeDiffStatus[node.id] : undefined;
      const isGhostNode = diffStatus === 'removed';

      return {
        ...node,
        hidden,
        draggable: !isGhostNode,
        data: {
          ...node.data,
          diffStatus,
          onFocus: setFocusedNodeId,
          onHover: setHoveredNodeId,
          onHoverEnd: () => setHoveredNodeId(null),
          analysisOverrides,
        },
        style: { ...node.style, opacity, transition: 'opacity 0.2s ease-in-out' }
      };
    });
  }, [nodes, focusedNodeId, hoveredNodeId, connectedNodeIds, searchQuery, analysisState, degreeMap, maxDegree, impactResult, impactTargetId, cycleResult, complexityMap, clusterMap, searchIsolatedResult, isDiffMode, diffGraph]);

  // ─── Compute display edges ─────────────
  const displayEdges = useMemo(() => {
    return edges.map((edge: any) => {
      let opacity = 1;
      let stroke = '#94a3b8';
      let strokeWidth = 2;
      let hidden = false;
      
      if (searchIsolatedResult && !searchIsolatedResult.edgeIds.has(edge.id)) {
        hidden = true;
      }

      if (impactTargetId && analysisState.impactRadius && impactResult) {
        opacity = impactResult.edgeIds.has(edge.id) ? 1 : 0.15;
      } else if (focusedNodeId && !analysisState.impactRadius) {
        opacity = connectedEdgeIds.has(edge.id) ? 1 : 0.15;
      }

      // Cycle edges
      if (cycleResult && cycleResult.cycleEdgeIds.has(edge.id)) {
        stroke = '#ef4444';
        strokeWidth = 3;
      }

      // Diff mode edge colouring
      if (isDiffMode && diffGraph) {
        const edgeDiffKey = `${edge.source}->${edge.target}`;
        const edgeStatus = diffGraph.edgeDiffStatus[edgeDiffKey];
        if (edgeStatus === 'added') {
          stroke = '#22c55e';
          strokeWidth = 3;
        } else if (edgeStatus === 'removed') {
          stroke = '#ef4444';
          strokeWidth = 2;
        }
        // 'unchanged' keeps default colour
      }

      return {
        ...edge,
        hidden,
        animated: isDiffMode && diffGraph ? (diffGraph.edgeDiffStatus[`${edge.source}->${edge.target}`] !== 'removed') : edge.animated,
        style: {
          ...edge.style,
          stroke,
          strokeWidth,
          opacity,
          strokeDasharray: (isDiffMode && diffGraph && diffGraph.edgeDiffStatus[`${edge.source}->${edge.target}`] === 'removed') ? '6 3' : undefined,
          transition: 'opacity 0.2s ease-in-out'
        }
      };
    });
  }, [edges, focusedNodeId, hoveredNodeId, connectedEdgeIds, analysisState, impactResult, impactTargetId, cycleResult, searchIsolatedResult, isDiffMode, diffGraph]);

  return (
    <>
      <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10 }}>
        <input 
          type="text" 
          placeholder="Isolate by node..." 
          value={localSearchQuery}
          onChange={e => updateSearchQuery(e.target.value)}
          style={{
            padding: '6px 12px',
            background: 'var(--vscode-input-background)',
            color: 'var(--vscode-input-foreground)',
            border: '1px solid var(--vscode-input-border)',
            borderRadius: '4px',
            width: '240px',
            outline: 'none',
            boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
          }}
        />
        {debouncedSearch && searchDropdownMatches.length > 0 && (
          <div style={{
            marginTop: '2px',
            background: 'var(--vscode-dropdown-background)',
            border: '1px solid var(--vscode-dropdown-border)',
            borderRadius: '4px',
            boxShadow: '0 8px 16px rgba(0,0,0,0.2)',
            maxHeight: '240px',
            overflowY: 'auto',
            width: '240px',
          }}>
            {searchDropdownMatches.map((n: any) => (
              <div
                key={n.id}
                onClick={() => { panToNode(n.id); setLocalSearchQuery(''); setDebouncedSearch(''); }}
                style={{
                  padding: '6px 12px',
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontFamily: 'var(--vscode-editor-font-family)',
                  borderBottom: '1px solid var(--vscode-dropdown-border)',
                  color: 'var(--vscode-dropdown-foreground)',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--vscode-list-hoverBackground)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ fontWeight: 500 }}>{n.name}</div>
                <div style={{ fontSize: '10px', opacity: 0.6, marginTop: '1px' }}>
                  {n.filePath.split(/[/\\]/).slice(-2).join('/')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onInit={setReactFlowInstance}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        maxZoom={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={2} color="var(--vscode-editorLineNumber-foreground)" />
        <Controls style={{ backgroundColor: 'var(--vscode-editorWidget-background)' }} />
        <Minimap />
      </ReactFlow>

      <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 10, display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
        {rootNodes.length > 0 && (
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setRootDropdownOpen(prev => !prev)}
              style={{
                background: 'var(--vscode-button-secondaryBackground)',
                color: 'var(--vscode-button-secondaryForeground)',
                border: 'none',
                padding: '8px 16px',
                borderRadius: '4px',
                fontWeight: 600,
                cursor: 'pointer',
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
                fontSize: '12px',
              }}
            >
              Go to Root ▾
            </button>
            {rootDropdownOpen && (
              <div style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: '4px',
                background: 'var(--vscode-dropdown-background)',
                border: '1px solid var(--vscode-dropdown-border)',
                borderRadius: '4px',
                boxShadow: '0 8px 16px rgba(0,0,0,0.2)',
                minWidth: '200px',
                maxHeight: '300px',
                overflowY: 'auto',
              }}>
                {rootNodes.map(n => (
                  <div
                    key={n.id}
                    onClick={() => panToNode(n.id)}
                    style={{
                      padding: '8px 12px',
                      cursor: 'pointer',
                      fontSize: '12px',
                      fontFamily: 'var(--vscode-editor-font-family)',
                      borderBottom: '1px solid var(--vscode-dropdown-border)',
                      color: 'var(--vscode-dropdown-foreground)',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--vscode-list-hoverBackground)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div style={{ fontWeight: 500 }}>{n.name}</div>
                    <div style={{ fontSize: '10px', opacity: 0.7, marginTop: '2px' }}>
                      {n.filePath.split(/[/\\]/).slice(-2).join('/')}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {focusedNodeId && (
          <button
            onClick={() => setFocusedNodeId(null)}
            style={{
              background: 'var(--vscode-button-background)',
              color: 'var(--vscode-button-foreground)',
              border: 'none',
              padding: '8px 16px',
              borderRadius: '4px',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)'
            }}
          >
            Clear Focus
          </button>
        )}
      </div>
    </>
  );
}
