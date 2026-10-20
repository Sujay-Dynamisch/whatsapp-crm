'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type Edge as RfEdge,
  type EdgeChange,
  type Node as RfNode,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { useTheme } from '@/hooks/use-theme';
import { slotsFor, type JourneyGraph, type JourneyNode, type NodeConfigs } from '@/lib/journeys/graph';
import { MUTED_SLOTS, NODE_ACCENT, NODE_ICON, summarize, type Lookups } from './node-meta';

export interface NodeStats {
  entered: number;
  failed: number;
  exits: Record<string, number>;
}

interface CardData extends Record<string, unknown> {
  node: JourneyNode;
  title: string;
  summary: string;
  slotLabels: Record<string, string>;
  stats: NodeStats | null;
  /** Share of everyone who entered the journey that reached this step. */
  reach: number | null;
  hasIssue: boolean;
}

function pct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`;
}

function JourneyCard({ data, selected }: NodeProps) {
  const d = data as CardData;
  const Icon = NODE_ICON[d.node.type];
  const slots = slotsFor(d.node);
  return (
    <div
      style={{ width: Math.max(220, slots.length * 64) }}
      className={cn(
        'rounded-xl border bg-card shadow-sm transition-shadow',
        selected ? 'border-primary ring-2 ring-primary/30' : 'border-border',
        d.hasIssue && !selected && 'border-amber-500/70'
      )}
    >
      {d.node.type !== 'trigger' && (
        <Handle type="target" position={Position.Top} className="!h-2.5 !w-2.5 !border-2 !border-primary !bg-card" />
      )}
      <div className="flex items-start gap-2 p-3">
        <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg border', NODE_ACCENT[d.node.type])}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 text-sm font-semibold text-foreground">
            <span className="truncate">{d.title}</span>
            {d.hasIssue && <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />}
          </p>
          <p className="line-clamp-2 text-xs text-muted-foreground">{d.summary}</p>
        </div>
      </div>
      {d.stats && (
        <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[11px]">
          <span className="font-medium text-foreground">{d.stats.entered.toLocaleString()}</span>
          {d.reach !== null && <span className="text-muted-foreground">{pct(d.reach)}</span>}
          {d.stats.failed > 0 && <span className="text-destructive">✕ {d.stats.failed}</span>}
        </div>
      )}
      {slots.length > 0 && (
        <div className="relative flex h-5 justify-around border-t border-border">
          {slots.map((slot, i) => (
            <div key={slot} className="relative flex-1 text-center">
              <span className="block truncate px-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {d.slotLabels[slot]}
              </span>
              <Handle
                type="source"
                id={slot}
                position={Position.Bottom}
                style={{ left: `${((i + 0.5) / slots.length) * 100}%` }}
                className={cn(
                  '!h-3 !w-3 !border-2 !bg-card',
                  MUTED_SLOTS.has(slot) ? '!border-muted-foreground' : '!border-primary'
                )}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { journey: JourneyCard };

/**
 * React Flow's own chrome (zoom controls, edge labels, dots, the
 * connection line) drawn from the app's theme tokens, so the canvas
 * matches light and dark mode instead of React Flow's white defaults.
 */
const THEME_VARS = {
  '--xy-background-color': 'var(--background)',
  '--xy-background-pattern-dots-color': 'color-mix(in oklab, var(--muted-foreground) 35%, transparent)',
  '--xy-edge-stroke': 'var(--muted-foreground)',
  '--xy-edge-stroke-selected': 'var(--primary)',
  '--xy-connectionline-stroke': 'var(--primary)',
  '--xy-edge-label-background-color': 'var(--card)',
  '--xy-edge-label-color': 'var(--muted-foreground)',
  '--xy-controls-button-background-color': 'var(--card)',
  '--xy-controls-button-background-color-hover': 'var(--muted)',
  '--xy-controls-button-color': 'var(--foreground)',
  '--xy-controls-button-color-hover': 'var(--foreground)',
  '--xy-controls-button-border-color': 'var(--border)',
  '--xy-controls-box-shadow': '0 1px 3px rgb(0 0 0 / 0.25)',
  '--xy-selection-background-color': 'color-mix(in oklab, var(--primary) 12%, transparent)',
  '--xy-selection-border': '1px dashed var(--primary)',
} as React.CSSProperties;

export function JourneyCanvas({
  graph,
  onChange,
  lookups,
  stats,
  issueNodeIds,
  selectedId,
  onSelect,
  onOpen,
}: {
  graph: JourneyGraph;
  onChange: (graph: JourneyGraph) => void;
  lookups: Lookups;
  stats: Record<string, NodeStats> | null;
  issueNodeIds: Set<string>;
  selectedId: string | null;
  /** Click / drag only selects; double-click opens the step's settings. */
  onSelect: (id: string | null) => void;
  onOpen: (id: string) => void;
}) {
  const t = useTranslations('Journeys');
  const { mode } = useTheme();
  // React Flow measures each node once and hides it until measured. The
  // graph doesn't store sizes, so keep them here — otherwise every drag
  // update rebuilds the nodes unmeasured and they blink.
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  const enteredJourney = trigger ? (stats?.[trigger.id]?.entered ?? 0) : 0;

  const baseLabels = useMemo<Record<string, string>>(
    () => ({
      next: '',
      yes: t('slot.yes'),
      no: t('slot.no'),
      replied: t('slot.replied'),
      timeout: t('slot.timeout'),
      each: t('slot.each'),
      done: t('slot.done'),
      success: t('slot.success'),
      error: t('slot.error'),
      default: t('slot.default'),
    }),
    [t]
  );
  /** Switch cases are labelled by their own label or rule. */
  const labelsFor = useCallback(
    (n: JourneyNode): Record<string, string> => {
      if (n.type !== 'switch') return baseLabels;
      const cases = (n.config as NodeConfigs['switch']).cases ?? [];
      const labels = { ...baseLabels };
      cases.forEach((k, i) => {
        labels[`case_${i}`] = k.label?.trim() || (k.value ? String(k.value) : `#${i + 1}`);
      });
      return labels;
    },
    [baseLabels]
  );

  const rfNodes: RfNode[] = useMemo(
    () =>
      graph.nodes.map((n) => {
        const s = stats?.[n.id] ?? (stats ? { entered: 0, failed: 0, exits: {} } : null);
        return {
          id: n.id,
          type: 'journey',
          position: n.position,
          measured: measured[n.id],
          selected: n.id === selectedId,
          deletable: n.type !== 'trigger',
          data: {
            node: n,
            title: n.label?.trim() || t(`node.${n.type}`),
            summary: summarize(n, t as never, lookups),
            slotLabels: labelsFor(n),
            stats: s,
            reach: s && enteredJourney > 0 ? s.entered / enteredJourney : null,
            hasIssue: issueNodeIds.has(n.id),
          } satisfies CardData,
        };
      }),
    [graph.nodes, stats, selectedId, t, lookups, labelsFor, enteredJourney, issueNodeIds, measured]
  );

  const rfEdges: RfEdge[] = useMemo(() => {
    const edges: RfEdge[] = [];
    for (const n of graph.nodes) {
      const labels = labelsFor(n);
      for (const slot of slotsFor(n)) {
        const target = n.next[slot];
        if (!target) continue;
        const count = stats?.[n.id]?.exits[slot];
        const label = [labels[slot], count !== undefined ? count.toLocaleString() : '']
          .filter(Boolean)
          .join(' · ');
        edges.push({
          id: `${n.id}:${slot}`,
          source: n.id,
          sourceHandle: slot,
          target,
          label: label || undefined,
          labelBgPadding: [4, 2],
          labelStyle: { fontSize: 10 },
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { strokeDasharray: MUTED_SLOTS.has(slot) ? '4 3' : undefined },
        });
      }
    }
    return edges;
  }, [graph.nodes, stats, labelsFor]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      let next = graph;
      const sizes: Record<string, { width: number; height: number }> = {};
      for (const ch of changes) {
        if (ch.type === 'dimensions' && ch.dimensions) {
          sizes[ch.id] = ch.dimensions;
        } else if (ch.type === 'position' && ch.position) {
          next = {
            nodes: next.nodes.map((n) =>
              n.id === ch.id ? { ...n, position: { x: Math.round(ch.position!.x), y: Math.round(ch.position!.y) } } : n
            ),
          };
        } else if (ch.type === 'remove') {
          next = removeNode(next, ch.id);
        } else if (ch.type === 'select' && ch.selected) {
          onSelect(ch.id);
        }
      }
      if (Object.keys(sizes).length) setMeasured((m) => ({ ...m, ...sizes }));
      if (next !== graph) onChange(next);
    },
    [graph, onChange, onSelect]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      let next = graph;
      for (const ch of changes) {
        if (ch.type !== 'remove') continue;
        const [source, slot] = ch.id.split(':');
        next = {
          nodes: next.nodes.map((n) =>
            n.id === source ? { ...n, next: { ...n.next, [slot]: undefined } } : n
          ),
        };
      }
      if (next !== graph) onChange(next);
    },
    [graph, onChange]
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || !c.sourceHandle || c.source === c.target) return;
      onChange({
        nodes: graph.nodes.map((n) =>
          n.id === c.source ? { ...n, next: { ...n.next, [c.sourceHandle!]: c.target! } } : n
        ),
      });
    },
    [graph, onChange]
  );

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onPaneClick={() => onSelect(null)}
      onNodeClick={(_, n) => onSelect(n.id)}
      onNodeDoubleClick={(_, n) => onOpen(n.id)}
      colorMode={mode}
      style={THEME_VARS}
      zoomOnDoubleClick={false}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
      deleteKeyCode={['Backspace', 'Delete']}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
      <Controls showInteractive={false} className="overflow-hidden rounded-lg border border-border" />
    </ReactFlow>
  );
}

/** Remove a step and every connection pointing at it. */
export function removeNode(graph: JourneyGraph, id: string): JourneyGraph {
  const target = graph.nodes.find((n) => n.id === id);
  if (!target || target.type === 'trigger') return graph;
  return {
    nodes: graph.nodes
      .filter((n) => n.id !== id)
      .map((n) => ({
        ...n,
        next: Object.fromEntries(Object.entries(n.next).map(([k, v]) => [k, v === id ? undefined : v])),
      })),
  };
}
