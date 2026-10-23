'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  History,
  Loader2,
  Pause,
  Play,
  Plus,
  Save,
  UserPlus,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { JourneyCanvas, removeNode, type NodeStats } from '@/components/journeys/journey-canvas';
import { NodeConfigSheet, type LookupLists } from '@/components/journeys/node-config-sheet';
import { NODE_ICON, STEP_GROUPS } from '@/components/journeys/node-meta';
import { RunsSheet } from '@/components/journeys/runs-sheet';
import {
  newNode,
  slotsFor,
  validateGraph,
  type JourneyGraph,
  type JourneyNode,
  type JourneyNodeType,
} from '@/lib/journeys/graph';

interface Journey {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'paused';
  graph: JourneyGraph;
  webhook_token?: string | null;
}

export default function JourneyEditorPage() {
  const t = useTranslations('Journeys');
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const { accountId, canSendMessages } = useAuth();

  const [journey, setJourney] = useState<Journey | null>(null);
  const [graph, setGraph] = useState<JourneyGraph>({ nodes: [] });
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  // Selected = highlighted (anchor for "Add step"); open = settings drawer.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [lists, setLists] = useState<LookupLists>({ templates: [], tags: [], stages: [], members: [], customFields: [] });
  const [runsOpen, setRunsOpen] = useState(false);
  const [stats, setStats] = useState<Record<string, NodeStats> | null>(null);
  const [showStats, setShowStats] = useState(true);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollTag, setEnrollTag] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- load ----------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/journeys/${id}`);
      const data = await res.json().catch(() => ({}));
      if (cancelled) return;
      if (!res.ok) {
        setError(data?.error || `HTTP ${res.status}`);
        return;
      }
      setJourney(data.journey);
      setGraph(data.journey.graph);
      setName(data.journey.name);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    (async () => {
      const [tpl, tags, stages, members, fields] = await Promise.all([
        supabase.from('message_templates').select('name, language, body_text').eq('account_id', accountId).eq('status', 'APPROVED').order('name'),
        supabase.from('tags').select('id, name').eq('account_id', accountId).order('name'),
        supabase.from('pipeline_stages').select('id, name, position, pipeline_id, pipelines!inner(name, account_id)').eq('pipelines.account_id', accountId).order('position'),
        supabase.from('profiles').select('user_id, full_name').eq('account_id', accountId).order('full_name'),
        supabase.from('custom_fields').select('id, field_name').eq('account_id', accountId).order('field_name'),
      ]);
      setLists({
        templates: (tpl.data ?? []).map((r) => ({ name: r.name as string, language: (r.language as string) ?? 'en_US', body_text: (r.body_text as string) ?? '' })),
        tags: (tags.data ?? []) as { id: string; name: string }[],
        stages: (stages.data ?? []).map((s) => {
          const p = (Array.isArray(s.pipelines) ? s.pipelines[0] : s.pipelines) as { name?: string } | null;
          return { id: s.id as string, name: s.name as string, pipeline_id: s.pipeline_id as string, pipeline_name: p?.name ?? '' };
        }),
        members: (members.data ?? []).map((m) => ({ id: m.user_id as string, name: (m.full_name as string) || (m.user_id as string).slice(0, 8) })),
        customFields: (fields.data ?? []).map((f) => ({ id: f.id as string, name: f.field_name as string })),
      });
    })();
  }, [accountId]);

  const loadStats = useCallback(async () => {
    const res = await fetch(`/api/journeys/${id}/stats`);
    const data = await res.json().catch(() => null);
    if (res.ok && data) setStats(data.nodes);
  }, [id]);

  useEffect(() => {
    if (journey && journey.status !== 'draft') loadStats();
  }, [journey, loadStats]);

  // ---- derived -------------------------------------------------------
  const issues = useMemo(() => validateGraph(graph), [graph]);
  const issueNodeIds = useMemo(
    () => new Set(issues.map((i) => i.nodeId).filter((x): x is string => Boolean(x))),
    [issues]
  );
  const lookups = useMemo(
    () => ({
      tags: new Map(lists.tags.map((tag) => [tag.id, tag.name])),
      stages: new Map(lists.stages.map((s) => [s.id, `${s.pipeline_name} → ${s.name}`])),
      members: new Map(lists.members.map((m) => [m.id, m.name])),
    }),
    [lists]
  );
  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null;
  const opened = graph.nodes.find((n) => n.id === openId) ?? null;

  const update = useCallback((next: JourneyGraph) => {
    setGraph(next);
    setDirty(true);
  }, []);

  // ---- actions -------------------------------------------------------
  function addStep(type: JourneyNodeType) {
    const anchor = selected ?? graph.nodes[graph.nodes.length - 1];
    const node = newNode(type, {
      x: anchor ? anchor.position.x : 0,
      y: anchor ? anchor.position.y + 180 : 0,
    });
    let nodes = [...graph.nodes, node as JourneyNode];
    // Wire it from the anchor's first free slot, so adding is one tap.
    if (anchor) {
      const free = slotsFor(anchor).find((s) => !anchor.next[s]);
      if (free) {
        nodes = nodes.map((n) => (n.id === anchor.id ? { ...n, next: { ...n.next, [free]: node.id } } : n));
      }
    }
    update({ nodes });
    setSelectedId(node.id);
    setOpenId(node.id);
  }

  async function save(): Promise<boolean> {
    setSaving(true);
    try {
      const res = await fetch(`/api/journeys/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, graph }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || t('editor.saveFailed'));
        return false;
      }
      setJourney(data.journey);
      setDirty(false);
      toast.success(t('editor.saved'));
      return true;
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus() {
    if (!journey) return;
    const next = journey.status === 'active' ? 'paused' : 'active';
    if (next === 'active' && issues.length > 0) {
      toast.error(t('editor.fixIssues', { count: issues.length }));
      return;
    }
    setToggling(true);
    try {
      if (dirty && !(await save())) return;
      const res = await fetch(`/api/journeys/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || `HTTP ${res.status}`);
        return;
      }
      setJourney({ ...journey, status: next });
      toast.success(next === 'active' ? t('editor.activated') : t('editor.paused'));
    } finally {
      setToggling(false);
    }
  }

  async function enroll() {
    setEnrolling(true);
    try {
      const res = await fetch(`/api/journeys/${id}/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_id: enrollTag }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || `HTTP ${res.status}`);
        return;
      }
      toast.success(t('editor.enrolled', { enrolled: data.enrolled, skipped: data.skipped }));
      setEnrollOpen(false);
      loadStats();
    } finally {
      setEnrolling(false);
    }
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" onClick={() => router.push('/journeys')}>
          {t('editor.back')}
        </Button>
      </div>
    );
  }
  if (!journey) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const isActive = journey.status === 'active';

  return (
    // Fill the dashboard viewport; the canvas takes what the header leaves.
    <div className="-m-4 flex h-[calc(100dvh-3.5rem)] flex-col sm:-m-6">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2 sm:px-4">
        <Button variant="ghost" size="icon" onClick={() => router.push('/journeys')} aria-label={t('editor.back')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          className="h-9 min-w-0 flex-1 basis-40 font-semibold sm:max-w-xs"
          aria-label={t('editor.name')}
        />
        <span
          className={
            isActive
              ? 'rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400'
              : 'rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
          }
        >
          {t(`status.${journey.status}`)}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="sm" variant="outline" disabled={!canSendMessages} />}>
              <Plus className="h-4 w-4" />
              {t('editor.addStep')}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[70vh] w-56 overflow-y-auto">
              {STEP_GROUPS.map((group, gi) => (
                <DropdownMenuGroup key={group.key}>
                  {gi > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel>{t(`stepGroup.${group.key}`)}</DropdownMenuLabel>
                  {group.types.map((type) => {
                    const Icon = NODE_ICON[type];
                    return (
                      <DropdownMenuItem key={type} onClick={() => addStep(type)} className="gap-2">
                        <Icon className="h-4 w-4" />
                        {t(`node.${type}`)}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {journey.status !== 'draft' && (
            <Button size="sm" variant={showStats ? 'secondary' : 'outline'} onClick={() => setShowStats((v) => !v)}>
              <BarChart3 className="h-4 w-4" />
              <span className="hidden sm:inline">{t('editor.stats')}</span>
            </Button>
          )}
          {journey.status !== 'draft' && (
            <Button size="sm" variant="outline" onClick={() => setRunsOpen(true)}>
              <History className="h-4 w-4" />
              <span className="hidden sm:inline">{t('editor.runs')}</span>
            </Button>
          )}
          {isActive && (
            <Button size="sm" variant="outline" onClick={() => setEnrollOpen(true)} disabled={!canSendMessages}>
              <UserPlus className="h-4 w-4" />
              <span className="hidden sm:inline">{t('editor.enroll')}</span>
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={save} disabled={!dirty || saving || !canSendMessages}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            <span className="hidden sm:inline">{t('editor.save')}</span>
          </Button>
          <Button size="sm" onClick={toggleStatus} disabled={toggling || !canSendMessages}>
            {toggling ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isActive ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {isActive ? t('editor.pause') : t('editor.activate')}
          </Button>
        </div>
      </div>

      {issues.length > 0 && (
        <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {t('editor.issues', { count: issues.length })}{' '}
            <span className="opacity-80">{issues.slice(0, 2).map((i) => i.message).join(' · ')}</span>
          </span>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <JourneyCanvas
          graph={graph}
          onChange={update}
          lookups={lookups}
          stats={showStats ? stats : null}
          issueNodeIds={issueNodeIds}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onOpen={(nodeId) => {
            setSelectedId(nodeId);
            setOpenId(nodeId);
          }}
        />
      </div>

      <NodeConfigSheet
        node={opened}
        graph={graph}
        journeyId={id}
        lists={lists}
        issues={issues}
        webhookUrl={
          journey.webhook_token && typeof window !== 'undefined'
            ? `${window.location.origin}/api/journeys/hooks/${journey.webhook_token}`
            : null
        }
        onChange={(node) => update({ nodes: graph.nodes.map((n) => (n.id === node.id ? node : n)) })}
        onDelete={(nodeId) => {
          update(removeNode(graph, nodeId));
          setSelectedId(null);
          setOpenId(null);
        }}
        onClose={() => setOpenId(null)}
      />

      <RunsSheet journeyId={id} graph={graph} open={runsOpen} onOpenChange={setRunsOpen} />

      <Dialog open={enrollOpen} onOpenChange={setEnrollOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('editor.enrollTitle')}</DialogTitle>
            <DialogDescription>{t('editor.enrollDesc')}</DialogDescription>
          </DialogHeader>
          <select
            className="h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm text-foreground"
            value={enrollTag}
            onChange={(e) => setEnrollTag(e.target.value)}
          >
            <option value="">{t('form.chooseTag')}</option>
            {lists.tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEnrollOpen(false)}>
              {t('editor.cancel')}
            </Button>
            <Button onClick={enroll} disabled={!enrollTag || enrolling}>
              {enrolling && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('editor.enroll')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
