'use client';

import { useTranslations } from 'next-intl';
import {
  Copy,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  List,
  Phone,
  Play,
  Reply,
} from 'lucide-react';
import { renderWhatsAppText } from '@/lib/whatsapp/format-text';
import type { TemplateButton } from '@/types';

export interface TemplatePreviewProps {
  headerFormat: 'none' | 'text' | 'image' | 'video' | 'document';
  headerText: string;
  headerSample: string;
  headerMediaUrl: string;
  bodyText: string;
  bodySamples: string[];
  footerText: string;
  buttons: TemplateButton[];
}

/** Swap `{{n}}` for its sample value; unfilled variables stay visible. */
function fillVariables(text: string, samples: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (match, n) => samples[Number(n) - 1]?.trim() || match);
}

const BUTTON_ICON: Record<TemplateButton['type'], typeof Reply> = {
  QUICK_REPLY: Reply,
  URL: ExternalLink,
  PHONE_NUMBER: Phone,
  COPY_CODE: Copy,
};

/**
 * Live preview of a standard template as a WhatsApp chat bubble —
 * header, body with sample values and WhatsApp formatting, footer, and
 * buttons. Like WhatsApp, more than three buttons collapse to two plus
 * "See all options".
 */
export function TemplatePreview({
  headerFormat,
  headerText,
  headerSample,
  headerMediaUrl,
  bodyText,
  bodySamples,
  footerText,
  buttons,
}: TemplatePreviewProps) {
  const t = useTranslations('Settings.templates');
  const body = fillVariables(bodyText, bodySamples);
  const header = fillVariables(headerText, [headerSample]);
  const shownButtons = buttons.length > 3 ? buttons.slice(0, 2) : buttons;

  return (
    <div className="overflow-hidden rounded-2xl border border-border shadow-lg">
      <div className="flex items-center gap-2 bg-[#008069] px-3 py-2.5 text-white dark:bg-[#202c33]">
        <div className="size-7 rounded-full bg-white/25" />
        <div className="text-xs font-semibold">{t('previewTitle')}</div>
      </div>

      <div className="min-h-[360px] bg-[#efeae2] p-3 dark:bg-[#0b141a]">
        <div className="max-w-[300px] rounded-lg rounded-tl-none bg-white text-[13px] leading-snug text-[#111b21] shadow-sm dark:bg-[#202c33] dark:text-[#e9edef]">
          {headerFormat === 'image' && (
            <div className="p-1 pb-0">
              {headerMediaUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={headerMediaUrl} alt="" className="max-h-48 w-full rounded-md object-cover" />
              ) : (
                <div className="flex h-36 items-center justify-center rounded-md bg-black/5 text-black/30 dark:bg-white/5 dark:text-white/30">
                  <ImageIcon className="size-10" />
                </div>
              )}
            </div>
          )}
          {headerFormat === 'video' && (
            <div className="p-1 pb-0">
              <div className="flex h-36 items-center justify-center rounded-md bg-black/70">
                <div className="flex size-11 items-center justify-center rounded-full bg-black/50 text-white">
                  <Play className="size-5 fill-current" />
                </div>
              </div>
            </div>
          )}
          {headerFormat === 'document' && (
            <div className="p-1 pb-0">
              <div className="flex items-center gap-2 rounded-md bg-black/5 px-3 py-3 dark:bg-white/5">
                <FileText className="size-7 shrink-0 text-red-500" />
                <span className="truncate text-xs">
                  {headerMediaUrl.split('/').pop()?.split('?')[0] || 'document.pdf'}
                </span>
              </div>
            </div>
          )}

          <div className="space-y-1 px-2.5 pt-2 pb-1.5">
            {headerFormat === 'text' && header.trim() && (
              <p className="font-bold break-words">{header}</p>
            )}
            <p className="whitespace-pre-wrap break-words">
              {body.trim() ? (
                renderWhatsAppText(body)
              ) : (
                <span className="text-black/40 dark:text-white/40">{t('previewEmpty')}</span>
              )}
            </p>
            {footerText.trim() && (
              <p className="text-[11px] text-[#667781] dark:text-[#8696a0]">{footerText}</p>
            )}
            <p className="text-right text-[10px] text-[#667781] dark:text-[#8696a0]">10:42</p>
          </div>

          {buttons.length > 0 && (
            <div className="divide-y divide-black/10 border-t border-black/10 dark:divide-white/10 dark:border-white/10">
              {shownButtons.map((btn, i) => {
                const Icon = BUTTON_ICON[btn.type] ?? Reply;
                return (
                  <div
                    key={i}
                    className="flex items-center justify-center gap-1.5 py-2 text-[13px] font-medium text-[#027eb5] dark:text-[#53bdeb]"
                  >
                    <Icon className="size-3.5" />
                    <span className="truncate">{btn.text || t('previewButton')}</span>
                  </div>
                );
              })}
              {buttons.length > 3 && (
                <div className="flex items-center justify-center gap-1.5 py-2 text-[13px] font-medium text-[#027eb5] dark:text-[#53bdeb]">
                  <List className="size-3.5" />
                  {t('previewSeeAll')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
