import React, { useState } from 'react';
import { Handle, Position } from '@xyflow/react';

export default function FunctionNode({ data }: { data: any }) {
  const [isHovered, setIsHovered] = useState(false);
  const paramsList = data.params.map((p: any) => p.type ? `${p.name}: ${p.type}` : p.name).join(', ');

  const diffStatus: string | undefined = data.diffStatus; // 'added' | 'removed' | 'changed' | 'unchanged' | undefined
  const isGhost = diffStatus === 'removed';

  const handleGoto = () => {
    if (isGhost) return; // Ghost nodes can't navigate
    window.vscode.postMessage({
      type: 'GOTO_FUNCTION',
      filePath: data.filePath,
      startLine: data.startLine
    });
  };

  // Get last 2 segments of path
  const pathParts = data.filePath.split(/[/\\]/);
  const shortPath = pathParts.slice(-2).join('/');

  let kindColor = '#2d2d2d'; // default function dark
  let borderColor = '#444'; 
  
  switch (data.kind) {
    case 'component':
      kindColor = '#0f766e'; // teal
      borderColor = '#134e4a';
      break;
    case 'hook':
      kindColor = '#6b21a8'; // purple
      borderColor = '#4c1d95';
      break;
    case 'class':
      kindColor = '#9a3412'; // orange
      borderColor = '#7c2d12';
      break;
    case 'method':
      kindColor = '#1e40af'; // blue
      borderColor = '#1e3a8a';
      break;
  }

  // Diff status overrides
  if (diffStatus === 'added') {
    borderColor = '#22c55e';
  } else if (diffStatus === 'removed') {
    borderColor = '#ef4444';
  } else if (diffStatus === 'changed') {
    borderColor = '#f59e0b';
  }

  // Analysis overrides from FlowCanvas (heatmap, cycles, clusters, glow)
  const overrides = data.analysisOverrides || {};
  const finalBorderColor = overrides.borderColor || borderColor;
  const finalTopColor = overrides.borderTopColor || kindColor;
  const clusterBg = overrides.backgroundColor || undefined;

  return (
    <div 
      className="function-node" 
      onClick={handleGoto} 
      onMouseEnter={() => { setIsHovered(true); data.onHover?.(data.id); }}
      onMouseLeave={() => { setIsHovered(false); data.onHoverEnd?.(); }}
      style={{ 
        position: 'relative',
        borderColor: finalBorderColor, 
        borderTopWidth: 4, 
        borderTopColor: diffStatus === 'added' ? '#22c55e' : diffStatus === 'removed' ? '#ef4444' : diffStatus === 'changed' ? '#f59e0b' : finalTopColor,
        borderStyle: isGhost ? 'dashed' : 'solid',
        boxShadow: overrides.boxShadow || undefined,
        background: clusterBg ? `${clusterBg}22` : undefined,
        opacity: isGhost ? 0.4 : 1,
        cursor: isGhost ? 'default' : 'pointer',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: '#555', border: 'none', width: '8px', height: '8px' }} />

      {isHovered && !isGhost && (
        <button 
          onClick={(e) => { e.stopPropagation(); data.onFocus?.(data.id); }}
          style={{
            position: 'absolute',
            top: '-12px',
            right: '-12px',
            background: 'var(--vscode-button-background)',
            color: 'var(--vscode-button-foreground)',
            border: 'none',
            borderRadius: '12px',
            padding: '2px 8px',
            fontSize: '10px',
            fontWeight: 'bold',
            cursor: 'pointer',
            boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
            zIndex: 10
          }}
        >
          FOCUS
        </button>
      )}
      
      <div className="fn-header" style={{ borderBottom: `1px solid ${finalBorderColor}` }}>
        <div>
          <div className="fn-name">{data.name}</div>
          <div className="fn-path">{shortPath}</div>
        </div>
        <div className="pill-container">
          {diffStatus === 'added' && <span className="pill" style={{ background: '#22c55e', color: '#fff' }}>NEW</span>}
          {diffStatus === 'removed' && <span className="pill" style={{ background: '#ef4444', color: '#fff' }}>REMOVED</span>}
          {diffStatus === 'changed' && <span className="pill" style={{ background: '#f59e0b', color: '#000' }}>CHANGED</span>}
          {data.isEntryPoint && <span className="pill entry">entry</span>}
          {data.isAsync && <span className="pill async">async</span>}
        </div>
      </div>

      <div className="fn-params" title={paramsList}>
        ({paramsList.length > 50 ? paramsList.substring(0, 50) + '...' : paramsList})
      </div>

      {data.returnType && data.kind !== 'component' && (
        <div className="fn-return" title={data.returnType}>
          <span style={{ opacity: 0.6 }}>→</span> {data.returnType.length > 30 ? data.returnType.substring(0, 30) + '...' : data.returnType}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: '#38bdf8', border: 'none', width: '8px', height: '8px' }} />
    </div>
  );
}
