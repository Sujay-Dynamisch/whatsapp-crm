'use client';

// Pricing card buttons: "Choose plan" opens WhatsApp with a purchase
// message; "Pay via UPI" opens a small payment window — a button that
// launches the phone's UPI apps (WhatsApp Pay, GPay, PhonePe…) with the
// amount filled in, a QR code to scan from a computer, and a WhatsApp
// "I've paid" message. The QR is drawn in the browser (no third party).

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Copy,
  IndianRupee,
  MessageCircle,
  QrCode,
  Smartphone,
  X,
} from 'lucide-react';

import { PAYMENT, paidLink, purchaseLink, upiLink, type Plan } from './content';

export function PlanActions({ plan }: { plan: Plan }) {
  const [open, setOpen] = useState(false);
  const canPay = Boolean(plan.amount && PAYMENT.upiId);
  return (
    <>
      <a
        href={purchaseLink(plan)}
        target="_blank"
        rel="noopener noreferrer"
        className={`mt-5 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-center text-sm font-semibold transition-colors ${
          plan.highlight
            ? 'bg-emerald-400 text-black hover:bg-emerald-300'
            : 'border border-white/15 bg-white/5 text-white hover:bg-white/10'
        }`}
      >
        <MessageCircle className="h-4 w-4" />
        {plan.cta}
      </a>
      {canPay && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-2 inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-400/10"
        >
          <IndianRupee className="h-3.5 w-3.5" />
          Pay {plan.price} now via UPI
        </button>
      )}
      {/* Portal: the card's reveal animation (a transform) would otherwise
          trap this fixed overlay inside the card. */}
      {open &&
        createPortal(
          <PayDialog plan={plan} onClose={() => setOpen(false)} />,
          document.body
        )}
    </>
  );
}

function PayDialog({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const link = upiLink(plan);

  useEffect(() => {
    let alive = true;
    // Loaded only when someone opens the payment window.
    import('qrcode')
      .then((QRCode) =>
        QRCode.toString(link, {
          type: 'svg',
          margin: 1,
          errorCorrectionLevel: 'M',
          color: { dark: '#0d1117', light: '#ffffff' },
        })
      )
      .then((svg) => alive && setQr(svg))
      .catch(() => alive && setQr(null));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      alive = false;
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [link, onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(PAYMENT.upiId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — the ID is visible to copy by hand
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Pay for the ${plan.name} plan`}
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm animate-[lp-pop_.25s_ease-out] rounded-2xl border border-white/10 bg-[#161b22] p-6 text-slate-200 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-semibold tracking-[0.15em] text-emerald-400 uppercase">
              {plan.name} plan · 1 month
            </p>
            <p className="mt-1 text-3xl font-semibold text-white">
              {plan.price}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Phone: open the UPI apps directly */}
        <a
          href={link}
          className="mt-5 flex items-center justify-center gap-2 rounded-xl bg-emerald-400 px-4 py-3 text-sm font-semibold text-black transition-colors hover:bg-emerald-300"
        >
          <Smartphone className="h-4 w-4" />
          Pay with WhatsApp Pay / GPay / PhonePe
        </a>
        <p className="mt-1.5 text-center text-[11px] text-slate-400">
          Opens your UPI app with the amount filled in (on your phone)
        </p>

        {/* Computer: scan the QR with a phone */}
        <div className="mt-5 flex items-center gap-4 rounded-xl border border-white/10 bg-black/20 p-3">
          <div
            className="h-28 w-28 shrink-0 overflow-hidden rounded-lg bg-white"
            aria-label="UPI QR code"
          >
            {qr ? (
              <div
                className="h-full w-full [&>svg]:h-full [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: qr }}
              />
            ) : (
              <QrCode className="m-auto h-full w-12 text-slate-400" />
            )}
          </div>
          <div className="min-w-0 text-xs">
            <p className="font-medium text-white">On a computer?</p>
            <p className="mt-0.5 text-slate-400">
              Scan with any UPI app on your phone.
            </p>
            <button
              type="button"
              onClick={() => void copy()}
              className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 font-mono text-[11px] text-slate-200 hover:bg-white/10"
            >
              <span className="truncate">{PAYMENT.upiId}</span>
              {copied ? (
                <Check className="h-3 w-3 shrink-0 text-emerald-400" />
              ) : (
                <Copy className="h-3 w-3 shrink-0" />
              )}
            </button>
          </div>
        </div>

        {/* Then tell us */}
        <a
          href={paidLink(plan)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-5 flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-white/10"
        >
          <MessageCircle className="h-4 w-4 text-emerald-400" />
          Paid? Send the receipt on WhatsApp
        </a>
        <p className="mt-3 text-center text-[11px] leading-relaxed text-slate-400">
          Your account is activated once we confirm the payment. WhatsApp
          message charges are billed separately at Meta’s rates.
        </p>
      </div>
    </div>
  );
}
