'use client';

import { useState } from 'react';
import { Plus, Trash2, ChevronLeft, ChevronRight, ShoppingBag, Sparkles, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import type { CarouselCard, TemplateButton } from '@/types';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';

interface CarouselBuilderProps {
  carousel: CarouselCard[];
  onChange: (carousel: CarouselCard[]) => void;
  topBodyText: string;
  onTopBodyTextChange: (text: string) => void;
}

const DEFAULT_CARD: CarouselCard = {
  header_format: 'PRODUCT_CORNER',
  catalog_id: '',
  product_retailer_id: '',
  header_media_url: '',
  body_text: 'Product description {{1}}',
  sample_values: { body: ['Special Offer'] },
  buttons: [{ type: 'QUICK_REPLY', text: 'View Product' }],
};

export function CarouselBuilder({
  carousel,
  onChange,
  topBodyText,
  onTopBodyTextChange,
}: CarouselBuilderProps) {
  const [activeCardIndex, setActiveCardIndex] = useState(0);

  const cards = carousel.length >= 2 ? carousel : [
    { ...DEFAULT_CARD, product_retailer_id: 'SKU-001', body_text: 'Featured product {{1}}', sample_values: { body: ['$99'] } },
    { ...DEFAULT_CARD, product_retailer_id: 'SKU-002', body_text: 'Best seller item {{1}}', sample_values: { body: ['$149'] } },
  ];

  const activeCard = cards[activeCardIndex] ?? cards[0];

  const updateCard = (index: number, updated: Partial<CarouselCard>) => {
    const next = cards.map((c, i) => (i === index ? { ...c, ...updated } : c));
    onChange(next);
  };

  const addCard = () => {
    if (cards.length >= 10) return;
    const newCard: CarouselCard = {
      ...DEFAULT_CARD,
      product_retailer_id: `SKU-00${cards.length + 1}`,
      body_text: `Item ${cards.length + 1} details {{1}}`,
      sample_values: { body: ['New'] },
    };
    const next = [...cards, newCard];
    onChange(next);
    setActiveCardIndex(next.length - 1);
  };

  const removeCard = (index: number) => {
    if (cards.length <= 2) return;
    const next = cards.filter((_, i) => i !== index);
    onChange(next);
    if (activeCardIndex >= next.length) {
      setActiveCardIndex(next.length - 1);
    }
  };

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

  const updateCardSample = (cardIdx: number, sampleIdx: number, val: string) => {
    const currentSamples = [...(cards[cardIdx].sample_values?.body ?? [])];
    currentSamples[sampleIdx] = val;
    updateCard(cardIdx, { sample_values: { body: currentSamples } });
  };

  const addCardButton = (cardIdx: number) => {
    const currentBtns = cards[cardIdx].buttons ?? [];
    if (currentBtns.length >= 2) return;
    updateCard(cardIdx, {
      buttons: [...currentBtns, { type: 'QUICK_REPLY', text: 'More Info' }],
    });
  };

  const moveCardLeft = (index: number) => {
    if (index <= 0) return;
    const next = [...cards];
    const temp = next[index - 1];
    next[index - 1] = next[index];
    next[index] = temp;
    onChange(next);
    setActiveCardIndex(index - 1);
  };

  const moveCardRight = (index: number) => {
    if (index >= cards.length - 1) return;
    const next = [...cards];
    const temp = next[index + 1];
    next[index + 1] = next[index];
    next[index] = temp;
    onChange(next);
    setActiveCardIndex(index + 1);
  };

  const updateCardButton = (cardIdx: number, btnIdx: number, updated: TemplateButton) => {
    const currentBtns = [...(cards[cardIdx].buttons ?? [])];
    currentBtns[btnIdx] = updated;
    updateCard(cardIdx, { buttons: currentBtns });
  };

  const duplicateCard = (index: number) => {
    if (cards.length >= 10) return;
    const target = cards[index];
    const cloned: CarouselCard = JSON.parse(JSON.stringify(target));
    const next = [...cards.slice(0, index + 1), cloned, ...cards.slice(index + 1)];
    onChange(next);
    setActiveCardIndex(index + 1);
  };

  const updateCardFormat = (format: 'PRODUCT_CORNER' | 'IMAGE' | 'VIDEO') => {
    const next = cards.map((c) => ({
      ...c,
      header_format: format,
    }));
    onChange(next);
  };

  const removeCardButton = (cardIdx: number, btnIdx: number) => {
    const currentBtns = (cards[cardIdx].buttons ?? []).filter((_, i) => i !== btnIdx);
    updateCard(cardIdx, { buttons: currentBtns });
  };

  // Preview helper for evaluating body text variables with sample values
  const renderPreviewBody = (text: string, samples: string[]) => {
    if (!text) return '';
    let result = text;
    samples.forEach((sample, i) => {
      result = result.replace(`{{${i + 1}}}`, sample || `{{${i + 1}}}`);
    });
    return result;
  };

  const currentType = activeCard.header_format === 'IMAGE' || activeCard.header_format === 'VIDEO' ? 'MEDIA' : 'PRODUCT';

  return (
    <div className="space-y-6">
      {/* Top-level template message body */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium text-foreground">
            Template Intro Message (Optional Body)
          </Label>
          <span className="text-xs text-muted-foreground">
            Appears above the carousel cards
          </span>
        </div>
        <Textarea
          placeholder="e.g. Check out our latest items below!"
          value={topBodyText}
          onChange={(e) => onTopBodyTextChange(e.target.value)}
          className="bg-muted border-border text-foreground text-sm min-h-[70px]"
        />
      </div>

      {/* Carousel Configuration Section */}
      <div className="rounded-xl border border-border/80 bg-card p-4 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border/40 pb-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <ShoppingBag className="h-4 w-4 text-primary" /> Carousel Configuration
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Meta WhatsApp Carousel requires between 2 and 10 cards.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={currentType}
              onValueChange={(val) => {
                const newFormat = val === 'MEDIA' ? 'IMAGE' : 'PRODUCT_CORNER';
                const next = cards.map((c) => ({ ...c, header_format: newFormat as CarouselCard['header_format'] }));
                onChange(next);
              }}
            >
              <SelectTrigger className="w-44 bg-muted border-border text-xs text-foreground h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover border-border">
                <SelectItem value="PRODUCT">Product Card Carousel</SelectItem>
                <SelectItem value="MEDIA">Media Carousel (Image/Video)</SelectItem>
              </SelectContent>
            </Select>

            <Badge variant="outline" className="text-xs border-primary/40 bg-primary/10 text-primary shrink-0">
              {cards.length} / 10 Cards
            </Badge>
          </div>
        </div>

        {/* Card Tab Navigation */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-2 scrollbar-thin">
          {cards.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setActiveCardIndex(i)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                activeCardIndex === i
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <span>Card {i + 1}</span>
              {cards.length > 2 && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    removeCard(i);
                  }}
                  className="rounded hover:bg-black/20 p-0.5 transition-colors"
                  title="Remove card"
                >
                  <Trash2 className="h-3 w-3" />
                </span>
              )}
            </button>
          ))}
          {cards.length < 10 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addCard}
              className="h-8 border-dashed border-primary/50 text-primary hover:bg-primary/10 text-xs gap-1 shrink-0"
            >
              <Plus className="h-3.5 w-3.5" /> Add Card
            </Button>
          )}
        </div>

        {/* Active Card Form */}
        <div className="space-y-4 rounded-lg border border-border/60 bg-muted/30 p-4">
          <div className="flex items-center justify-between border-b border-border/40 pb-2">
            <span className="text-xs font-semibold text-foreground flex items-center gap-2">
              Configuring Card #{activeCardIndex + 1}
            </span>

            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={activeCardIndex === 0}
                onClick={() => moveCardLeft(activeCardIndex)}
                className="h-7 text-xs text-muted-foreground hover:text-foreground px-2"
                title="Move Card Left"
              >
                <ChevronLeft className="h-3.5 w-3.5 mr-0.5" /> Move Left
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={activeCardIndex === cards.length - 1}
                onClick={() => moveCardRight(activeCardIndex)}
                className="h-7 text-xs text-muted-foreground hover:text-foreground px-2"
                title="Move Card Right"
              >
                Move Right <ChevronRight className="h-3.5 w-3.5 ml-0.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={cards.length >= 10}
                onClick={() => duplicateCard(activeCardIndex)}
                className="h-7 text-xs text-muted-foreground hover:text-foreground px-2"
                title="Duplicate Card"
              >
                <Copy className="h-3 w-3 mr-1" /> Duplicate
              </Button>
              {cards.length > 2 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeCard(activeCardIndex)}
                  className="h-7 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 px-2"
                >
                  <Trash2 className="mr-1 h-3 w-3" /> Remove
                </Button>
              )}
            </div>
          </div>

          {/* Header Format & Catalog/Product info */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Header Format</Label>
              <Select
                value={activeCard.header_format ?? 'PRODUCT_CORNER'}
                onValueChange={(val) =>
                  updateCardFormat(val as 'PRODUCT_CORNER' | 'IMAGE' | 'VIDEO')
                }
              >
                <SelectTrigger className="w-full bg-muted border-border text-xs text-foreground h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-popover border-border">
                  <SelectItem value="PRODUCT_CORNER">Product Card (PRODUCT_CORNER)</SelectItem>
                  <SelectItem value="IMAGE">Card Image (IMAGE)</SelectItem>
                  <SelectItem value="VIDEO">Card Video (VIDEO)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {activeCard.header_format === 'IMAGE' || activeCard.header_format === 'VIDEO' ? (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  {activeCard.header_format === 'VIDEO' ? 'Sample Card Video URL' : 'Sample Card Image URL'}
                </Label>
                <Input
                  placeholder={activeCard.header_format === 'VIDEO' ? 'https://example.com/video.mp4' : 'https://example.com/image.jpg'}
                  value={activeCard.header_media_url ?? ''}
                  onChange={(e) => updateCard(activeCardIndex, { header_media_url: e.target.value })}
                  className="bg-muted border-border text-xs text-foreground h-9"
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Product Retailer ID / SKU (Sample)</Label>
                <Input
                  placeholder="e.g. SKU-1001"
                  value={activeCard.product_retailer_id ?? ''}
                  onChange={(e) => updateCard(activeCardIndex, { product_retailer_id: e.target.value })}
                  className="bg-muted border-border text-xs text-foreground h-9"
                />
              </div>
            )}
          </div>

          {/* Optional Catalog ID override for Product Card */}
          {activeCard.header_format === 'PRODUCT_CORNER' && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Sample Catalog ID (Optional)</Label>
              <Input
                placeholder="e.g. 1234567890"
                value={activeCard.catalog_id ?? ''}
                onChange={(e) => updateCard(activeCardIndex, { catalog_id: e.target.value })}
                className="bg-muted border-border text-xs text-foreground h-9"
              />
            </div>
          )}

          {/* Card Body Text */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Card Body Text (Max 160 chars)</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => insertCardVariable(activeCardIndex)}
                className="h-6 text-[11px] px-2 border-border text-muted-foreground hover:text-foreground"
              >
                + Add Variable
              </Button>
            </div>
            <Textarea
              placeholder="e.g. Premium item description {{1}}"
              maxLength={160}
              value={activeCard.body_text ?? ''}
              onChange={(e) => updateCard(activeCardIndex, { body_text: e.target.value })}
              className="bg-muted border-border text-xs text-foreground min-h-[60px]"
            />
          </div>

          {/* Card Body Variable Samples */}
          {extractVariableIndices(activeCard.body_text ?? '').length > 0 && (
            <div className="space-y-2 border-t border-border/40 pt-2">
              <Label className="text-xs font-medium text-foreground">Card Body Sample Values</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {extractVariableIndices(activeCard.body_text ?? '').map((varIdx, i) => (
                  <div key={varIdx} className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px] shrink-0 font-mono">
                      {`{{${varIdx}}}`}
                    </Badge>
                    <Input
                      placeholder={`Sample value for {{${varIdx}}}`}
                      value={activeCard.sample_values?.body?.[i] ?? ''}
                      onChange={(e) => updateCardSample(activeCardIndex, i, e.target.value)}
                      className="bg-muted border-border text-xs text-foreground h-8"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Card Buttons */}
          <div className="space-y-2 border-t border-border/40 pt-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium text-foreground">Card Buttons (Max 2 per card)</Label>
              {(activeCard.buttons ?? []).length < 2 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => addCardButton(activeCardIndex)}
                  className="h-6 text-[11px] px-2 border-border text-primary hover:bg-primary/10"
                >
                  <Plus className="h-3 w-3 mr-1" /> Add Button
                </Button>
              )}
            </div>

            {(activeCard.buttons ?? []).map((btn, btnIdx) => (
              <div key={btnIdx} className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 p-2">
                <Select
                  value={btn.type}
                  onValueChange={(val) => {
                    if (val === 'URL') {
                      updateCardButton(activeCardIndex, btnIdx, {
                        type: 'URL',
                        text: btn.text,
                        url: btn.type === 'URL' ? btn.url : '',
                      });
                    } else {
                      updateCardButton(activeCardIndex, btnIdx, {
                        type: 'QUICK_REPLY',
                        text: btn.text,
                      });
                    }
                  }}
                >
                  <SelectTrigger className="w-32 bg-muted border-border text-xs text-foreground h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-popover border-border">
                    <SelectItem value="QUICK_REPLY">Quick Reply</SelectItem>
                    <SelectItem value="URL">URL</SelectItem>
                  </SelectContent>
                </Select>

                <Input
                  placeholder="Button Label"
                  maxLength={25}
                  value={btn.text}
                  onChange={(e) => {
                    const newText = e.target.value;
                    if (btn.type === 'URL') {
                      updateCardButton(activeCardIndex, btnIdx, {
                        type: 'URL',
                        text: newText,
                        url: btn.url,
                      });
                    } else if (btn.type === 'PHONE_NUMBER') {
                      updateCardButton(activeCardIndex, btnIdx, {
                        type: 'PHONE_NUMBER',
                        text: newText,
                        phone_number: btn.phone_number,
                      });
                    } else if (btn.type === 'COPY_CODE') {
                      updateCardButton(activeCardIndex, btnIdx, {
                        type: 'COPY_CODE',
                        text: newText,
                        example: btn.example,
                      });
                    } else {
                      updateCardButton(activeCardIndex, btnIdx, {
                        type: 'QUICK_REPLY',
                        text: newText,
                      });
                    }
                  }}
                  className="bg-muted border-border text-xs text-foreground h-8 flex-1"
                />

                {btn.type === 'URL' && (
                  <Input
                    placeholder="https://example.com/item"
                    value={btn.type === 'URL' ? btn.url : ''}
                    onChange={(e) =>
                      updateCardButton(activeCardIndex, btnIdx, {
                        type: 'URL',
                        text: btn.text,
                        url: e.target.value,
                      })
                    }
                    className="bg-muted border-border text-xs text-foreground h-8 flex-1"
                  />
                )}

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeCardButton(activeCardIndex, btnIdx)}
                  className="h-8 w-8 p-0 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        {/* Live Interactive WhatsApp Carousel Preview */}
        <div className="rounded-xl border border-border bg-slate-950/80 p-4 space-y-3 shadow-inner">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="font-medium flex items-center gap-1.5 text-slate-300">
              <Sparkles className="h-3.5 w-3.5 text-primary" /> Live Carousel Interactive Preview
            </span>
            <span>Card {activeCardIndex + 1} of {cards.length}</span>
          </div>

          {topBodyText && (
            <div className="rounded-lg bg-slate-900/90 border border-slate-800 p-3 text-xs text-slate-200">
              {topBodyText}
            </div>
          )}

          {/* Carousel Cards Track Preview */}
          <div className="relative overflow-hidden">
            <div className="flex items-center justify-between absolute top-1/2 left-1 right-1 z-10 -translate-y-1/2 pointer-events-none">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={activeCardIndex === 0}
                onClick={() => setActiveCardIndex(Math.max(0, activeCardIndex - 1))}
                className="h-7 w-7 rounded-full p-0 bg-slate-900/90 border border-slate-700 text-slate-200 shadow-md pointer-events-auto disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={activeCardIndex === cards.length - 1}
                onClick={() => setActiveCardIndex(Math.min(cards.length - 1, activeCardIndex + 1))}
                className="h-7 w-7 rounded-full p-0 bg-slate-900/90 border border-slate-700 text-slate-200 shadow-md pointer-events-auto disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>

            {/* Current Active Card Representation */}
            <div className="mx-auto max-w-xs rounded-xl border border-slate-800 bg-slate-900 p-3 shadow-lg space-y-2.5">
              {/* Product Header / Corner Representation */}
              <div className="relative flex h-36 w-full items-center justify-center rounded-lg bg-slate-800/80 border border-slate-700/60 overflow-hidden">
                {activeCard.header_format === 'IMAGE' && activeCard.header_media_url ? (
                  <img
                    src={activeCard.header_media_url}
                    alt="Card media"
                    className="h-full w-full object-cover"
                  />
                ) : activeCard.header_format === 'VIDEO' ? (
                  <div className="flex flex-col items-center justify-center gap-1 text-slate-300 p-3 text-center">
                    <span className="text-xl">▶</span>
                    <span className="text-[11px] font-medium">Video Header Card</span>
                    <span className="text-[10px] text-slate-400 truncate max-w-[180px]">
                      {activeCard.header_media_url || 'video.mp4'}
                    </span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center gap-1.5 text-slate-400 p-3 text-center">
                    <ShoppingBag className="h-8 w-8 text-primary opacity-80" />
                    <span className="text-[11px] font-medium text-slate-300">
                      Product Card (PRODUCT_CORNER)
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono">
                      {activeCard.product_retailer_id || 'SKU-SAMPLE'}
                    </span>
                  </div>
                )}
              </div>

              {/* Card Body */}
              <div className="text-xs text-slate-200 min-h-[36px] px-1">
                {renderPreviewBody(
                  activeCard.body_text ?? '',
                  activeCard.sample_values?.body ?? []
                ) || <span className="italic text-slate-500">No body text</span>}
              </div>

              {/* Card Buttons */}
              {activeCard.buttons && activeCard.buttons.length > 0 && (
                <div className="space-y-1.5 pt-1 border-t border-slate-800">
                  {activeCard.buttons.map((btn, bIdx) => (
                    <div
                      key={bIdx}
                      className="flex h-8 w-full items-center justify-center rounded-md bg-slate-800 text-xs font-medium text-primary hover:bg-slate-750 transition-colors"
                    >
                      {btn.text || `Button #${bIdx + 1}`}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
