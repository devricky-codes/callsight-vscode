import React from 'react';
import { MiniMap as ReactFlowMiniMap } from '@xyflow/react';

export default function Minimap() {
  return (
    <ReactFlowMiniMap 
      style={{
        backgroundColor: 'var(--vscode-editor-background)',
        border: '1px solid var(--vscode-editorWidget-border)',
        borderRadius: '4px',
      }}
      maskColor="rgba(0, 0, 0, 0.4)"
      nodeColor={(node) => {
        if (node.data?.isEntryPoint) return '#10b981';
        if (node.data?.isAsync) return '#f59e0b';
        return '#38bdf8';
      }}
      pannable
      zoomable
    />
  );
}
