'use client';

// A plain-language hover (and keyboard-focus) hint for a single button or
// link, so a non-technical user can see what a button does before
// clicking it. Wrap the element in <Hint text="...">…</Hint>; it adds no
// extra DOM node of its own. Works with native elements (<a>, <button>)
// and anything built on @base-ui's render prop (Button, etc).

import type { ReactElement } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function Hint({
  text,
  side = 'top',
  children,
}: {
  text: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactElement;
}) {
  if (!text) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side} className="max-w-56 text-left leading-snug font-normal">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
