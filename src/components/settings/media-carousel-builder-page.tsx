'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Plus,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Sparkles,
  Loader2,
  Upload,
  Send,
  Save,
  ImageIcon,
  VideoIcon,
  HelpCircle,
  ExternalLink,
  Phone,
  MessageSquare,
  CheckCircle2,
  Clock,
  XCircle,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { uploadAccountMedia } from '@/lib/storage/upload-media';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CarouselCard, TemplateButton } from '@/types';

const COMMON_LANGUAGES = [
  { code: 'en_US', label: 'English (US)' },
  { code: 'en_GB', label: 'English (UK)' },
  { code: 'es', label: 'Spanish' },
  { code: 'es_MX', label: 'Spanish (Mexico)' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt_BR', label: 'Portuguese (Brazil)' },
  { code: 'hi', label: 'Hindi' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ar', label: 'Arabic' },
];

const DEFAULT_CARD: CarouselCard = {
  header_format: 'IMAGE',
  header_media_url: 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=800',
  body_text: 'Special festive offer {{1}} available for all customers',
  sample_values: { body: ['$99'] },
  buttons: [{ type: 'QUICK_REPLY', text: 'View Product' }],
};

interface MediaCarouselBuilderPageProps {
  initialTemplateId?: string | null;
}

export function MediaCarouselBuilderPage({ initialTemplateId }: MediaCarouselBuilderPageProps) {
  const router = useRouter();
  const supabase = createClient();

  const [loading, setLoading] = useState(Boolean(initialTemplateId));
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [uploadingMedia, setUploadingMedia] = useState(false);

  // Form State
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('en_US');
  const [category] = useState<'Marketing'>('Marketing');
  const [status, setStatus] = useState<string>('DRAFT');
  const [bodyText, setBodyText] = useState('Hello {{1}}, check out our special festive collection! 👇');
  const [bodySamples, setBodySamples] = useState<string[]>(['Customer']);
  const [footerText, setFooterText] = useState('Tap a card to explore');
  const [headerFormat, setHeaderFormat] = useState<'IMAGE' | 'VIDEO'>('IMAGE');

  const [cards, setCards] = useState<CarouselCard[]>([
    {
      ...DEFAULT_CARD,
      body_text: 'Explore our special featured collection {{1}} now',
      sample_values: { body: ['20% OFF'] },
      buttons: [{ type: 'QUICK_REPLY', text: 'View Details' }],
    },
    {
      ...DEFAULT_CARD,
      body_text: 'Discover our top best seller item {{1}} today',
      sample_values: { body: ['Free Delivery'] },
      buttons: [{ type: 'QUICK_REPLY', text: 'Buy Now' }],
    },
  ]);

  const [activeCardIndex, setActiveCardIndex] = useState(0);
  const [previewCardIndex, setPreviewCardIndex] = useState(0);

  const activeCard = cards[activeCardIndex] ?? cards[0];
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load existing template if editing
  useEffect(() => {
    if (!initialTemplateId) return;
    (async () => {
      try {
        setLoading(true);
        const { data, error } = await supabase
          .from('message_templates')
          .select('*')
          .eq('id', initialTemplateId)
          .single();

        if (error || !data) {
          toast.error('Template not found');
          router.push('/settings?tab=templates');
          return;
        }

        setName(data.name);
        setLanguage(data.language || 'en_US');
        setBodyText(data.body_text || '');
        setFooterText(data.footer_text || '');
        setStatus(data.status || 'DRAFT');
        setBodySamples(data.sample_values?.body || []);

        if (Array.isArray(data.carousel) && data.carousel.length >= 2) {
          setCards(data.carousel);
          if (data.carousel[0]?.header_format === 'VIDEO') {
            setHeaderFormat('VIDEO');
          }
        }
      } catch (err) {
        console.error('Failed to load carousel template:', err);
        toast.error('Error loading template');
      } finally {
        setLoading(false);
      }
    })();
  }, [initialTemplateId, supabase, router]);

  // Extract variables in top body text
  const bodyVarIndices = useMemo(() => extractVariableIndices(bodyText), [bodyText]);

  useEffect(() => {
    setBodySamples((prev) => {
      if (prev.length === bodyVarIndices.length) return prev;
      const next = prev.slice(0, bodyVarIndices.length);
      while (next.length < bodyVarIndices.length) next.push('');
      return next;
    });
  }, [bodyVarIndices.length]);

  // Sync header_format across all cards when toggle changes
  const handleHeaderFormatChange = (fmt: 'IMAGE' | 'VIDEO') => {
    setHeaderFormat(fmt);
    setCards((prev) =>
      prev.map((c) => ({
        ...c,
        header_format: fmt,
      }))
    );
  };

  const updateCard = (index: number, patch: Partial<CarouselCard>) => {
    setCards((prev) =>
      prev.map((card, i) => (i === index ? { ...card, ...patch, header_format: headerFormat } : card))
    );
  };

  const addCard = () => {
    if (cards.length >= 10) {
      toast.error('Meta permits at most 10 cards per carousel template.');
      return;
    }
    const newCard: CarouselCard = {
      ...DEFAULT_CARD,
      header_format: headerFormat,
      body_text: `Item ${cards.length + 1} details {{1}}`,
      sample_values: { body: ['New'] },
    };
    const next = [...cards, newCard];
    setCards(next);
    setActiveCardIndex(next.length - 1);
    setPreviewCardIndex(next.length - 1);
  };

  const duplicateCard = (index: number) => {
    if (cards.length >= 10) {
      toast.error('Meta permits at most 10 cards per carousel template.');
      return;
    }
    const source = cards[index];
    const copy: CarouselCard = JSON.parse(JSON.stringify(source));
    const next = [...cards.slice(0, index + 1), copy, ...cards.slice(index + 1)];
    setCards(next);
    setActiveCardIndex(index + 1);
    setPreviewCardIndex(index + 1);
    toast.success(`Card #${index + 1} duplicated`);
  };

  const removeCard = (index: number) => {
    if (cards.length <= 2) {
      toast.error('Meta requires at least 2 cards in a carousel template.');
      return;
    }
    const next = cards.filter((_, i) => i !== index);
    setCards(next);
    const newIdx = Math.min(activeCardIndex, next.length - 1);
    setActiveCardIndex(newIdx);
    setPreviewCardIndex(newIdx);
  };

  const moveCard = (index: number, direction: 'left' | 'right') => {
    const targetIdx = direction === 'left' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= cards.length) return;
    const next = [...cards];
    const [moved] = next.splice(index, 1);
    next.splice(targetIdx, 0, moved);
    setCards(next);
    setActiveCardIndex(targetIdx);
    setPreviewCardIndex(targetIdx);
  };

  // Card media upload
  const handleMediaUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setUploadingMedia(true);
      const { publicUrl } = await uploadAccountMedia('chat-media', file);
      updateCard(activeCardIndex, { header_media_url: publicUrl });
      toast.success('Media header uploaded successfully!');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Media upload failed');
    } finally {
      setUploadingMedia(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Card Variable Helpers
  const insertCardVariable = (index: number) => {
    const text = activeCard.body_text ?? '';
    const vars = extractVariableIndices(text);
    const nextVarNum = vars.length + 1;
    const updatedText = text ? `${text} {{${nextVarNum}}}` : `{{${nextVarNum}}}`;
    const samples = activeCard.sample_values?.body ?? [];
    const updatedSamples = [...samples, `Sample ${nextVarNum}`];
    updateCard(index, {
      body_text: updatedText,
      sample_values: { body: updatedSamples },
    });
  };

  // Buttons handling
  const addCardButton = (type: TemplateButton['type']) => {
    const currentBtns = activeCard.buttons ?? [];
    if (currentBtns.length >= 2) {
      toast.error('Meta permits at most 2 buttons per carousel card.');
      return;
    }

    let newBtn: TemplateButton = { type: 'QUICK_REPLY', text: 'More Info' };
    if (type === 'URL') {
      newBtn = { type: 'URL', text: 'Visit Website', url: 'https://example.com/{{1}}', example: 'promo' };
    } else if (type === 'PHONE_NUMBER') {
      newBtn = { type: 'PHONE_NUMBER', text: 'Call Us', phone_number: '+15551234567' };
    }

    updateCard(activeCardIndex, {
      buttons: [...currentBtns, newBtn],
    });
  };

  const removeCardButton = (btnIdx: number) => {
    const currentBtns = activeCard.buttons ?? [];
    updateCard(activeCardIndex, {
      buttons: currentBtns.filter((_, i) => i !== btnIdx),
    });
  };

  const updateCardButton = (btnIdx: number, patch: Partial<TemplateButton>) => {
    const currentBtns = [...(activeCard.buttons ?? [])];
    currentBtns[btnIdx] = { ...currentBtns[btnIdx], ...patch } as TemplateButton;
    updateCard(activeCardIndex, { buttons: currentBtns });
  };

  // Submit to Meta or Save Draft
  const handleSave = async (submitToMeta: boolean) => {
    const templateNameClean = name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!templateNameClean) {
      toast.error('Template name is required (lowercase letters, numbers, underscores).');
      return;
    }
    if (cards.length < 2) {
      toast.error('Carousel template requires at least 2 cards.');
      return;
    }

    try {
      if (submitToMeta) setSubmitting(true);
      else setSavingDraft(true);

      const payload = {
        name: templateNameClean,
        category: 'Marketing',
        language: language.trim() || 'en_US',
        template_type: 'carousel',
        body_text: bodyText.trim(),
        footer_text: footerText.trim() || undefined,
        carousel: cards.map((c, i) => ({
          ...c,
          card_index: i,
          header_format: headerFormat,
        })),
        sample_values: bodySamples.some((v) => v.trim()) ? { body: bodySamples.map((v) => v.trim()) } : undefined,
      };

      const isEdit = initialTemplateId !== null && initialTemplateId !== undefined;
      const endpoint = isEdit
        ? `/api/whatsapp/templates/${initialTemplateId}`
        : '/api/whatsapp/templates/submit';

      const res = await fetch(endpoint, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, dryRun: !submitToMeta }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to submit template');
      }

      if (submitToMeta) {
        toast.success('Carousel template submitted to Meta for approval!');
      } else {
        toast.success('Carousel template draft saved successfully!');
      }

      router.push('/settings?tab=templates');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error saving carousel template');
    } finally {
      setSubmitting(false);
      setSavingDraft(false);
    }
  };

  // Preview Substitution Helpers
  const renderedTopBody = useMemo(() => {
    let text = bodyText;
    bodyVarIndices.forEach((idx, i) => {
      const val = bodySamples[i] || `{{${idx}}}`;
      text = text.replaceAll(`{{${idx}}}`, val);
    });
    return text;
  }, [bodyText, bodyVarIndices, bodySamples]);

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12 max-w-7xl mx-auto">
      {/* Top Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push('/settings?tab=templates')}
            className="h-9 gap-1 text-xs border-border bg-card text-foreground hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Templates
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-foreground" />
                {initialTemplateId ? 'Edit Media Carousel Template' : 'Create Media Carousel Template'}
              </h1>
              <Badge variant="outline" className="bg-muted border-border text-foreground font-mono text-[10px]">
                CAROUSEL
              </Badge>
              {status === 'APPROVED' ? (
                <Badge className="bg-emerald-950 text-emerald-300 border-emerald-800 text-[10px] gap-1">
                  <CheckCircle2 className="h-3 w-3" /> Approved
                </Badge>
              ) : status === 'PENDING' ? (
                <Badge className="bg-amber-950 text-amber-300 border-amber-800 text-[10px] gap-1">
                  <Clock className="h-3 w-3" /> Pending Approval
                </Badge>
              ) : status === 'REJECTED' ? (
                <Badge className="bg-red-950 text-red-300 border-red-800 text-[10px] gap-1">
                  <XCircle className="h-3 w-3" /> Rejected
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px]">Draft</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Build a multi-card interactive carousel template and submit it directly to Meta for WhatsApp Business approval.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleSave(false)}
            disabled={savingDraft || submitting}
            className="h-9 text-xs gap-1.5 border-border bg-card text-foreground hover:bg-muted"
          >
            {savingDraft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save Draft
          </Button>

          <Button
            size="sm"
            onClick={() => handleSave(true)}
            disabled={submitting || savingDraft}
            className="h-9 text-xs gap-1.5 bg-foreground text-background font-semibold hover:bg-foreground/90 shadow-sm"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Submit for Meta Approval
          </Button>
        </div>
      </div>

      {/* Main Grid: Form Editor (Left 7 cols) & Mobile Live Preview (Right 5 cols) */}
      <div className="grid gap-6 lg:grid-cols-12 items-start">
        {/* Left Form Column */}
        <div className="lg:col-span-7 space-y-6">
          {/* Section 1: Template Basic Details */}
          <Card className="bg-card border-border text-card-foreground">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold flex items-center gap-2 text-foreground">
                1. Template Basic Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-xs">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-foreground font-medium">Template Name</Label>
                  <Input
                    placeholder="e.g. navaratri_special_garba"
                    value={name}
                    onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                    className="bg-muted border-border text-foreground font-mono text-xs h-9"
                  />
                  <p className="text-[10px] text-muted-foreground">Lowercase letters, numbers, and underscores only.</p>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-foreground font-medium">Language</Label>
                  <Select value={language} onValueChange={(val) => setLanguage(val || 'en_US')}>
                    <SelectTrigger className="bg-muted border-border text-foreground text-xs h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-popover border-border text-popover-foreground text-xs">
                      {COMMON_LANGUAGES.map((lang) => (
                        <SelectItem key={lang.code} value={lang.code}>
                          {lang.label} ({lang.code})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted/50 border border-border">
                <div className="space-y-0.5">
                  <p className="font-semibold text-foreground">Category: Marketing</p>
                  <p className="text-[11px] text-muted-foreground">Meta requires all Carousel templates to be categorized under Marketing.</p>
                </div>
                <Badge variant="outline" className="bg-muted border-border text-foreground text-[10px]">
                  {category}
                </Badge>
              </div>
            </CardContent>
          </Card>

          {/* Section 2: Top Message Body Text */}
          <Card className="bg-card border-border text-card-foreground">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold flex items-center gap-2 text-foreground">
                2. Top Message Body Text
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-xs">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-foreground font-medium">Introductory Body Text</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setBodyText((prev) => `${prev} {{${bodyVarIndices.length + 1}}}`)}
                    className="h-6 text-[10px] text-foreground font-medium hover:bg-muted"
                  >
                    + Add Variable {"{{"}{bodyVarIndices.length + 1}{"}}"}
                  </Button>
                </div>
                <Textarea
                  rows={3}
                  placeholder="e.g. Hello {{1}}, check out our special festive collection! 👇"
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  className="bg-muted border-border text-foreground text-xs leading-relaxed"
                />
              </div>

              {/* Body Variables Samples */}
              {bodyVarIndices.length > 0 && (
                <div className="space-y-2 p-3 rounded-lg bg-muted/40 border border-border">
                  <p className="font-medium text-foreground text-[11px] flex items-center gap-1">
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />
                    Top Body Variable Examples (Required by Meta review)
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {bodyVarIndices.map((varIdx, i) => (
                      <div key={varIdx} className="flex items-center gap-2">
                        <span className="font-mono text-muted-foreground w-12 text-right text-[11px] shrink-0">
                          {`{{${varIdx}}}`}:
                        </span>
                        <Input
                          placeholder={`Sample value for {{${varIdx}}}`}
                          value={bodySamples[i] ?? ''}
                          onChange={(e) => {
                            const next = [...bodySamples];
                            next[i] = e.target.value;
                            setBodySamples(next);
                          }}
                          className="bg-background border-border text-foreground text-xs h-8"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </CardContent>
          </Card>

          {/* Section 3: Carousel Cards Editor */}
          <Card className="bg-card border-border text-card-foreground">
            <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
              <div>
                <CardTitle className="text-sm font-bold flex items-center gap-2 text-foreground">
                  3. Carousel Cards Deck ({cards.length} / 10 Cards)
                </CardTitle>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Meta requires 2 to 10 cards per carousel. All cards share identical header format.
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {/* Format Toggle */}
                <div className="flex items-center rounded-lg bg-muted p-1 border border-border">
                  <button
                    type="button"
                    onClick={() => handleHeaderFormatChange('IMAGE')}
                    className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-md transition-colors ${
                      headerFormat === 'IMAGE'
                        ? 'bg-foreground text-background font-medium'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <ImageIcon className="h-3 w-3" /> Image
                  </button>
                  <button
                    type="button"
                    onClick={() => handleHeaderFormatChange('VIDEO')}
                    className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-md transition-colors ${
                      headerFormat === 'VIDEO'
                        ? 'bg-foreground text-background font-medium'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <VideoIcon className="h-3 w-3" /> Video
                  </button>
                </div>

                <Button
                  type="button"
                  size="sm"
                  onClick={addCard}
                  disabled={cards.length >= 10}
                  className="h-8 text-xs gap-1 border border-border bg-muted text-foreground hover:bg-muted/80"
                >
                  <Plus className="h-3.5 w-3.5" /> Add Card
                </Button>
              </div>
            </CardHeader>

            <CardContent className="space-y-4 text-xs">
              {/* Cards Tab Strip */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-2 border-b border-border scrollbar-thin">
                {cards.map((c, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      setActiveCardIndex(idx);
                      setPreviewCardIndex(idx);
                    }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border shrink-0 transition-all ${
                      idx === activeCardIndex
                        ? 'bg-muted border-foreground/30 text-foreground font-bold shadow-sm'
                        : 'bg-background border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <span>Card #{idx + 1}</span>
                    {c.buttons?.length ? (
                      <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 border-border bg-muted">
                        {c.buttons.length} btn
                      </Badge>
                    ) : null}
                  </button>
                ))}
              </div>

              {/* Active Card Configuration Panel */}
              <div className="space-y-4 p-4 rounded-xl bg-muted/30 border border-border">
                {/* Active Card Header Tools */}
                <div className="flex items-center justify-between border-b border-border pb-3">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-foreground text-sm">Configuring Card #{activeCardIndex + 1}</span>
                    <Badge variant="outline" className="text-[10px] bg-muted border-border">
                      {headerFormat} HEADER
                    </Badge>
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => moveCard(activeCardIndex, 'left')}
                      disabled={activeCardIndex === 0}
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      title="Move Left"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => moveCard(activeCardIndex, 'right')}
                      disabled={activeCardIndex === cards.length - 1}
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      title="Move Right"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => duplicateCard(activeCardIndex)}
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      title="Duplicate Card"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeCard(activeCardIndex)}
                      disabled={cards.length <= 2}
                      className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10"
                      title="Remove Card"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {/* Card Header Media Upload & URL */}
                <div className="space-y-2">
                  <Label className="text-foreground font-medium">Card Header Media ({headerFormat})</Label>
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                    <Input
                      type="url"
                      placeholder={headerFormat === 'IMAGE' ? 'https://example.com/item.jpg' : 'https://example.com/video.mp4'}
                      value={activeCard.header_media_url ?? ''}
                      onChange={(e) => updateCard(activeCardIndex, { header_media_url: e.target.value })}
                      className="bg-muted border-border text-foreground text-xs h-9 flex-1"
                    />

                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={headerFormat === 'IMAGE' ? 'image/jpeg,image/png' : 'video/mp4'}
                      onChange={handleMediaUpload}
                      className="hidden"
                    />

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadingMedia}
                      className="h-9 text-xs gap-1.5 border-border bg-muted hover:bg-muted/80 shrink-0"
                    >
                      {uploadingMedia ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5 text-foreground" />}
                      Upload File
                    </Button>
                  </div>
                </div>

                {/* Card Body Description */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-foreground font-medium">Card Description (Max 160 chars)</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => insertCardVariable(activeCardIndex)}
                      className="h-5 text-[10px] text-foreground font-medium hover:bg-muted"
                    >
                      + Add {"{{"}{extractVariableIndices(activeCard.body_text ?? '').length + 1}{"}}"}
                    </Button>
                  </div>
                  <Textarea
                    rows={2}
                    maxLength={160}
                    placeholder="Featured Item details {{1}}"
                    value={activeCard.body_text ?? ''}
                    onChange={(e) => updateCard(activeCardIndex, { body_text: e.target.value })}
                    className="bg-muted border-border text-foreground text-xs"
                  />
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>Meta limit: 160 characters</span>
                    <span>{(activeCard.body_text ?? '').length} / 160</span>
                  </div>
                </div>

                {/* Card Body Variable Samples */}
                {extractVariableIndices(activeCard.body_text ?? '').length > 0 && (
                  <div className="space-y-2 p-2.5 rounded-lg bg-muted/50 border border-border">
                    <p className="font-medium text-foreground text-[11px]">Card #{activeCardIndex + 1} Body Variables Example</p>
                    {extractVariableIndices(activeCard.body_text ?? '').map((varIdx, i) => (
                      <div key={varIdx} className="flex items-center gap-2">
                        <span className="font-mono text-muted-foreground text-[11px] w-10 text-right">{`{{${varIdx}}}`}:</span>
                        <Input
                          placeholder={`Sample value for card {{${varIdx}}}`}
                          value={activeCard.sample_values?.body?.[i] ?? ''}
                          onChange={(e) => {
                            const samples = [...(activeCard.sample_values?.body ?? [])];
                            samples[i] = e.target.value;
                            updateCard(activeCardIndex, { sample_values: { body: samples } });
                          }}
                          className="bg-background border-border text-foreground text-xs h-8"
                        />
                      </div>
                    ))}
                  </div>
                )}

                {/* Card Action Buttons (Max 2 per card) */}
                <div className="space-y-2.5 pt-2 border-t border-border">
                  <div className="flex items-center justify-between">
                    <Label className="text-foreground font-medium">Card Action Buttons (Max 2)</Label>

                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => addCardButton('QUICK_REPLY')}
                        disabled={(activeCard.buttons?.length ?? 0) >= 2}
                        className="h-6 text-[10px] text-foreground font-medium hover:bg-muted"
                      >
                        + Quick Reply
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => addCardButton('URL')}
                        disabled={(activeCard.buttons?.length ?? 0) >= 2}
                        className="h-6 text-[10px] text-foreground font-medium hover:bg-muted"
                      >
                        + URL Button
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => addCardButton('PHONE_NUMBER')}
                        disabled={(activeCard.buttons?.length ?? 0) >= 2}
                        className="h-6 text-[10px] text-foreground font-medium hover:bg-muted"
                      >
                        + Phone
                      </Button>
                    </div>
                  </div>

                  {(activeCard.buttons ?? []).map((btn, btnIdx) => (
                    <div key={btnIdx} className="p-3 rounded-lg bg-muted/40 border border-border space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[9px] bg-background border-border">
                            {btn.type}
                          </Badge>
                          <span className="text-foreground font-medium">Button #{btnIdx + 1}</span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeCardButton(btnIdx)}
                          className="h-6 w-6 p-0 text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>

                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="space-y-1">
                          <Label className="text-[11px] text-muted-foreground">Button Label Text</Label>
                          <Input
                            placeholder="e.g. View Product"
                            maxLength={25}
                            value={btn.text}
                            onChange={(e) => updateCardButton(btnIdx, { text: e.target.value })}
                            className="bg-background border-border text-foreground text-xs h-8"
                          />
                        </div>

                        {btn.type === 'URL' && (
                          <div className="space-y-1">
                            <Label className="text-[11px] text-muted-foreground">URL Target (http/https)</Label>
                            <Input
                              placeholder="https://example.com/item/{{1}}"
                              value={btn.url ?? ''}
                              onChange={(e) => updateCardButton(btnIdx, { url: e.target.value })}
                              className="bg-background border-border text-foreground text-xs h-8 font-mono"
                            />
                          </div>
                        )}

                        {btn.type === 'PHONE_NUMBER' && (
                          <div className="space-y-1">
                            <Label className="text-[11px] text-muted-foreground">Phone Number (+E.164)</Label>
                            <Input
                              placeholder="+15551234567"
                              value={btn.phone_number ?? ''}
                              onChange={(e) => updateCardButton(btnIdx, { phone_number: e.target.value })}
                              className="bg-background border-border text-foreground text-xs h-8 font-mono"
                            />
                          </div>
                        )}
                      </div>

                      {btn.type === 'URL' && extractVariableIndices(btn.url ?? '').length > 0 && (
                        <div className="space-y-1 pt-1 border-t border-border">
                          <Label className="text-[10px] text-foreground font-medium">URL Variable {"{{1}}"} Example</Label>
                          <Input
                            placeholder="e.g. promo123"
                            value={btn.example ?? ''}
                            onChange={(e) => updateCardButton(btnIdx, { example: e.target.value })}
                            className="bg-background border-border text-foreground text-xs h-7"
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Preview Column: Sticky Mobile Real-Time Preview */}
        <div className="lg:col-span-5 sticky top-6">
          <Card className="bg-card border-border text-card-foreground overflow-hidden shadow-xl">
            <CardHeader className="bg-muted/80 border-b border-border py-3 px-4">
              <CardTitle className="text-xs font-bold text-foreground flex items-center justify-between">
                <span>Real-Time WhatsApp Preview</span>
                <span className="text-[10px] font-mono text-muted-foreground">Mobile Mock</span>
              </CardTitle>
            </CardHeader>

            <CardContent className="p-4 bg-muted/20 min-h-[520px] flex flex-col justify-start">
              {/* WhatsApp Chat Envelope */}
              <div className="max-w-[340px] mx-auto w-full space-y-2">
                {/* Top Body Text Bubble */}
                <div className="bg-muted/80 text-foreground p-3 rounded-xl rounded-tl-none shadow-sm text-xs leading-relaxed space-y-1 border border-border">
                  <p className="whitespace-pre-wrap">{renderedTopBody || 'Introductory top body message...'}</p>
                  <div className="text-[9px] text-muted-foreground text-right font-mono">10:42 AM</div>
                </div>

                {/* Carousel Cards Deck View */}
                <div className="relative pt-2">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground pb-1 px-1">
                    <span>Card {previewCardIndex + 1} of {cards.length}</span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setPreviewCardIndex((prev) => Math.max(0, prev - 1))}
                        disabled={previewCardIndex === 0}
                        className="p-1 hover:text-foreground disabled:opacity-30"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewCardIndex((prev) => Math.min(cards.length - 1, prev + 1))}
                        disabled={previewCardIndex === cards.length - 1}
                        className="p-1 hover:text-foreground disabled:opacity-30"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {/* Active Card Preview Box */}
                  {cards[previewCardIndex] && (
                    <div className="bg-muted/60 border border-border rounded-xl overflow-hidden shadow-md transition-all">
                      {/* Media Header */}
                      <div className="h-44 bg-muted relative flex items-center justify-center overflow-hidden border-b border-border">
                        {cards[previewCardIndex].header_media_url ? (
                          headerFormat === 'VIDEO' ? (
                            <video
                              src={cards[previewCardIndex].header_media_url}
                              className="w-full h-full object-cover"
                              controls={false}
                              muted
                            />
                          ) : (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={cards[previewCardIndex].header_media_url}
                              alt="Card media"
                              className="w-full h-full object-cover"
                            />
                          )
                        ) : (
                          <div className="flex flex-col items-center justify-center text-muted-foreground gap-1 p-4 text-center">
                            {headerFormat === 'VIDEO' ? <VideoIcon className="h-8 w-8" /> : <ImageIcon className="h-8 w-8" />}
                            <span className="text-[11px]">Upload Card #{previewCardIndex + 1} Media</span>
                          </div>
                        )}
                        <Badge className="absolute top-2 right-2 text-[9px] bg-background/80 text-foreground border border-border backdrop-blur-sm">
                          #{previewCardIndex + 1}
                        </Badge>
                      </div>

                      {/* Card Body Text */}
                      <div className="p-3 text-xs text-foreground space-y-1">
                        <p className="font-medium whitespace-pre-wrap">
                          {(() => {
                            let text = cards[previewCardIndex].body_text || '';
                            const vars = extractVariableIndices(text);
                            const samples = cards[previewCardIndex].sample_values?.body || [];
                            vars.forEach((idx, i) => {
                              text = text.replaceAll(`{{${idx}}}`, samples[i] || `{{${idx}}}`);
                            });
                            return text || 'Card Body Text';
                          })()}
                        </p>
                      </div>

                      {/* Card Buttons */}
                      {cards[previewCardIndex].buttons?.length ? (
                        <div className="border-t border-border divide-y divide-border">
                          {cards[previewCardIndex].buttons?.map((btn, btnIdx) => (
                            <div
                              key={btnIdx}
                              className="p-2.5 text-center text-xs font-semibold text-emerald-400 hover:bg-muted/80 transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                            >
                              {btn.type === 'URL' && <ExternalLink className="h-3.5 w-3.5" />}
                              {btn.type === 'PHONE_NUMBER' && <Phone className="h-3.5 w-3.5" />}
                              {btn.type === 'QUICK_REPLY' && <MessageSquare className="h-3.5 w-3.5" />}
                              <span>{btn.text || 'Button'}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )}

                  {/* Card Pagination Dots */}
                  <div className="flex items-center justify-center gap-1.5 pt-3">
                    {cards.map((_, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setPreviewCardIndex(i)}
                        className={`h-1.5 rounded-full transition-all ${
                          i === previewCardIndex ? 'w-5 bg-foreground' : 'w-1.5 bg-muted-foreground/40'
                        }`}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
