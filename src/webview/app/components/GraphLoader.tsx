import React, { useEffect, useRef } from 'react';

/**
 * Animated loader that shows nodes appearing and edges connecting between them,
 * simulating a graph being progressively discovered.
 */

interface GraphLoaderProps {
  message?: string;
  submessage?: string;
}

interface Node {
  x: number;
  y: number;
  radius: number;
  opacity: number;
  targetOpacity: number;
  pulse: number;
  color: string;
}

interface Edge {
  from: number;
  to: number;
  progress: number; // 0-1 how far the edge has drawn
  opacity: number;
}

const COLORS = ['#38bdf8', '#10b981', '#f59e0b', '#a78bfa', '#f472b6', '#34d399'];

export default function GraphLoader({ message, submessage }: GraphLoaderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const stateRef = useRef<{ nodes: Node[]; edges: Edge[]; tick: number; nextNodeAt: number; nextEdgeAt: number }>({
    nodes: [],
    edges: [],
    tick: 0,
    nextNodeAt: 0,
    nextEdgeAt: 30,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = 260;
    const H = 180;
    canvas.width = W * 2; // retina
    canvas.height = H * 2;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.scale(2, 2);

    const MAX_NODES = 10;
    const state = stateRef.current;

    function addNode() {
      // Place nodes avoiding overlap, within padded bounds
      const pad = 30;
      let x: number, y: number, tries = 0;
      do {
        x = pad + Math.random() * (W - pad * 2);
        y = pad + Math.random() * (H - pad * 2);
        tries++;
      } while (
        tries < 20 &&
        state.nodes.some(n => Math.hypot(n.x - x, n.y - y) < 40)
      );

      state.nodes.push({
        x, y,
        radius: 4 + Math.random() * 3,
        opacity: 0,
        targetOpacity: 0.6 + Math.random() * 0.4,
        pulse: Math.random() * Math.PI * 2,
        color: COLORS[state.nodes.length % COLORS.length],
      });
    }

    function addEdge() {
      if (state.nodes.length < 2) return;
      // Pick a random pair that isn't already connected
      const existingKeys = new Set(state.edges.map(e => `${e.from}-${e.to}`));
      let tries = 0;
      while (tries < 15) {
        const from = Math.floor(Math.random() * state.nodes.length);
        let to = Math.floor(Math.random() * state.nodes.length);
        if (from === to) { tries++; continue; }
        const key = `${from}-${to}`;
        const keyRev = `${to}-${from}`;
        if (existingKeys.has(key) || existingKeys.has(keyRev)) { tries++; continue; }
        state.edges.push({ from, to, progress: 0, opacity: 0 });
        return;
      }
    }

    function draw() {
      if (!ctx) return;
      const { nodes, edges } = state;
      state.tick++;

      ctx.clearRect(0, 0, W, H);

      // Spawn nodes
      if (state.tick >= state.nextNodeAt && nodes.length < MAX_NODES) {
        addNode();
        state.nextNodeAt = state.tick + 20 + Math.floor(Math.random() * 25);
      }

      // Spawn edges
      if (state.tick >= state.nextEdgeAt && nodes.length >= 2) {
        addEdge();
        state.nextEdgeAt = state.tick + 15 + Math.floor(Math.random() * 20);
      }

      // When graph is full, reset for continuous animation
      if (nodes.length >= MAX_NODES && edges.length > MAX_NODES + 4) {
        // Fade out and reset
        let allFaded = true;
        for (const n of nodes) {
          n.targetOpacity = 0;
          if (n.opacity > 0.02) allFaded = false;
        }
        if (allFaded) {
          state.nodes = [];
          state.edges = [];
          state.nextNodeAt = state.tick + 10;
          state.nextEdgeAt = state.tick + 30;
        }
      }

      // Update nodes
      for (const n of nodes) {
        n.opacity += (n.targetOpacity - n.opacity) * 0.08;
        n.pulse += 0.04;
      }

      // Draw edges
      for (const e of edges) {
        const nFrom = nodes[e.from];
        const nTo = nodes[e.to];
        if (!nFrom || !nTo) continue;

        e.progress = Math.min(1, e.progress + 0.03);
        e.opacity = Math.min(nFrom.opacity, nTo.opacity) * 0.5;

        const ex = nFrom.x + (nTo.x - nFrom.x) * e.progress;
        const ey = nFrom.y + (nTo.y - nFrom.y) * e.progress;

        ctx.beginPath();
        ctx.moveTo(nFrom.x, nFrom.y);
        ctx.lineTo(ex, ey);
        ctx.strokeStyle = `rgba(148, 163, 184, ${e.opacity})`;
        ctx.lineWidth = 1;
        ctx.stroke();

        // Travelling dot on edge
        if (e.progress > 0.1) {
          const dotT = ((state.tick * 0.02) % 1) * e.progress;
          const dx = nFrom.x + (nTo.x - nFrom.x) * dotT;
          const dy = nFrom.y + (nTo.y - nFrom.y) * dotT;
          ctx.beginPath();
          ctx.arc(dx, dy, 1.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(56, 189, 248, ${e.opacity * 1.6})`;
          ctx.fill();
        }
      }

      // Draw nodes
      for (const n of nodes) {
        const pulseR = n.radius + Math.sin(n.pulse) * 1.2;

        // Outer glow
        ctx.beginPath();
        ctx.arc(n.x, n.y, pulseR + 4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(56, 189, 248, ${n.opacity * 0.08})`;
        ctx.fill();

        // Node circle
        ctx.beginPath();
        ctx.arc(n.x, n.y, pulseR, 0, Math.PI * 2);
        ctx.fillStyle = n.color.replace(')', `, ${n.opacity})`).replace('rgb', 'rgba');
        ctx.fill();

        // Bright center
        ctx.beginPath();
        ctx.arc(n.x, n.y, pulseR * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${n.opacity * 0.6})`;
        ctx.fill();
      }

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animRef.current);
      stateRef.current = { nodes: [], edges: [], tick: 0, nextNodeAt: 0, nextEdgeAt: 30 };
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
      <canvas ref={canvasRef} style={{ borderRadius: '8px' }} />
      {message && <p style={{ fontSize: '14px', margin: 0, opacity: 0.9 }}>{message}</p>}
      {submessage && <p style={{ fontSize: '12px', margin: 0, opacity: 0.55 }}>{submessage}</p>}
    </div>
  );
}
