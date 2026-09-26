'use client';

import { useState } from 'react';
import { Code, Copy, Check, Terminal, Bug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';

export interface DebugPayloadData {
  operation: 'CREATE_CAROUSEL_TEMPLATE' | 'SEND_CAROUSEL_TEMPLATE';
  normalizedTemplate: Record<string, unknown>;
  metaRequestPayload: Record<string, unknown>;
  httpStatus?: number;
  metaResponse?: Record<string, unknown>;
  metaError?: Record<string, unknown>;
  fbtraceId?: string;
  wabaId?: string;
  phoneNumberId?: string;
}

interface MetaPayloadDebuggerProps {
  data: DebugPayloadData;
  triggerLabel?: string;
}

export function MetaPayloadDebugger({ data, triggerLabel = 'Meta Payload Debugger' }: MetaPayloadDebuggerProps) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);

  // Redact any sensitive tokens/credentials if present
  const sanitizedRequest = JSON.parse(
    JSON.stringify(data.metaRequestPayload, (key, value) => {
      if (typeof key === 'string' && (key.toLowerCase().includes('token') || key.toLowerCase().includes('secret'))) {
        return '[REDACTED]';
      }
      return value;
    })
  );

  const copyToClipboard = async () => {
    try {
      const payloadString = JSON.stringify(sanitizedRequest, null, 2);
      await navigator.clipboard.writeText(payloadString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard write failures
    }
  };

  const endpointPath =
    data.operation === 'CREATE_CAROUSEL_TEMPLATE'
      ? `POST /v21.0/${data.wabaId || '{WABA_ID}'}/message_templates`
      : `POST /v21.0/${data.phoneNumberId || '{PHONE_NUMBER_ID}'}/messages`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 border-border bg-card text-foreground hover:bg-muted text-xs"
          >
            <Bug className="h-3.5 w-3.5" />
            <span>{triggerLabel}</span>
          </Button>
        }
      />

      <DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-y-auto bg-card text-card-foreground border-border">
        <DialogHeader>
          <div className="flex items-center justify-between pr-6">
            <DialogTitle className="text-base font-bold flex items-center gap-2 text-foreground">
              <Terminal className="h-4 w-4 text-muted-foreground" />
              Meta API Payload Debugger
              <Badge variant="outline" className="text-[10px] bg-muted border-border text-foreground">
                {data.operation}
              </Badge>
            </DialogTitle>

            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={copyToClipboard}
              className="h-7 text-xs gap-1.5 bg-muted hover:bg-muted/80 text-foreground border border-border"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copied ? 'Copied!' : 'Copy Payload'}</span>
            </Button>
          </div>
        </DialogHeader>

        <div className="space-y-4 pt-2 text-xs font-mono">
          {/* Target Endpoint & HTTP Status */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 p-3 border border-border">
            <div className="space-y-0.5">
              <p className="text-[11px] text-muted-foreground font-sans">Target Graph API Endpoint</p>
              <p className="text-emerald-400 font-semibold">{endpointPath}</p>
            </div>
            {data.httpStatus && (
              <Badge
                className={
                  data.httpStatus >= 200 && data.httpStatus < 300
                    ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                    : 'bg-red-950 text-red-300 border-red-800'
                }
              >
                HTTP {data.httpStatus}
              </Badge>
            )}
          </div>

          {/* 1. Final Meta API Request Payload */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-muted-foreground font-sans text-[11px]">
              <span className="font-semibold text-foreground">1. Final Meta API Request Payload</span>
              <span>(No Access Tokens)</span>
            </div>
            <pre className="p-3 rounded-lg bg-muted/50 border border-border text-foreground overflow-x-auto text-[11px] leading-relaxed">
              {JSON.stringify(sanitizedRequest, null, 2)}
            </pre>
          </div>

          {/* 2. Normalized Internal Template */}
          <div className="space-y-1.5">
            <p className="font-semibold text-foreground font-sans text-[11px]">2. Normalized Internal Template</p>
            <pre className="p-3 rounded-lg bg-muted/50 border border-border text-foreground overflow-x-auto text-[11px] leading-relaxed">
              {JSON.stringify(data.normalizedTemplate, null, 2)}
            </pre>
          </div>

          {/* 3. Meta API Response / Error */}
          {data.metaResponse && (
            <div className="space-y-1.5">
              <p className="font-semibold text-foreground font-sans text-[11px]">3. Meta Response</p>
              <pre className="p-3 rounded-lg bg-muted/50 border border-border text-emerald-400 overflow-x-auto text-[11px] leading-relaxed">
                {JSON.stringify(data.metaResponse, null, 2)}
              </pre>
            </div>
          )}

          {data.metaError && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-red-400 font-sans text-[11px]">
                <span className="font-semibold">3. Meta API Error Response</span>
                {data.fbtraceId && <span className="font-mono text-[10px]">fbtrace_id: {data.fbtraceId}</span>}
              </div>
              <pre className="p-3 rounded-lg bg-red-950/40 border border-red-900/60 text-red-300 overflow-x-auto text-[11px] leading-relaxed">
                {JSON.stringify(data.metaError, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
