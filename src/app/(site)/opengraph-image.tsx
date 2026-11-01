import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';

// The link preview banner (WhatsApp, Facebook, LinkedIn, X…) for "/".
// Next.js adds the og:image / twitter:image tags with absolute URLs from
// metadataBase (NEXT_PUBLIC_SITE_URL). No emoji: ImageResponse would fetch
// emoji images from a CDN at build time.

export const alt = 'Flowza — WhatsApp CRM & business automation. Plans from ₹999/month.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpenGraphImage() {
  const font = (f: string) => readFile(join(process.cwd(), 'assets/fonts', f));
  // Inter (SIL Open Font License, assets/fonts/LICENSE-Inter.txt). The
  // latin-ext files carry the ₹ sign.
  const [logo, bold, medium, boldExt, mediumExt] = await Promise.all([
    readFile(join(process.cwd(), 'public/brand/flowza-circle-512.png')),
    font('Inter-Bold.woff'),
    font('Inter-Medium.woff'),
    font('Inter-Bold-LatinExt.woff'),
    font('Inter-Medium-LatinExt.woff'),
  ]);
  const logoSrc = `data:image/png;base64,${logo.toString('base64')}`;

  const chip = (text: string) => (
    <div
      style={{
        display: 'flex',
        padding: '10px 18px',
        borderRadius: 999,
        border: '1px solid rgba(255,255,255,0.14)',
        background: 'rgba(255,255,255,0.05)',
        color: '#d1d9e0',
        fontSize: 22,
      }}
    >
      {text}
    </div>
  );
  const bubble = (text: string, mine: boolean, time: string) => (
    <div
      style={{
        display: 'flex',
        alignSelf: mine ? 'flex-end' : 'flex-start',
        maxWidth: 330,
        padding: '12px 16px',
        borderRadius: 18,
        borderTopRightRadius: mine ? 4 : 18,
        borderTopLeftRadius: mine ? 18 : 4,
        background: mine ? '#005c4b' : '#202c33',
        color: '#ffffff',
        fontSize: 20,
        lineHeight: 1.35,
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex' }}>{text}</div>
      <div style={{ display: 'flex', alignSelf: 'flex-end', marginTop: 4, fontSize: 14, color: 'rgba(255,255,255,0.55)' }}>
        {time}
        {mine ? (
          // WhatsApp's blue double tick (drawn: the default font has no ✓).
          <svg width="22" height="14" viewBox="0 0 22 14" style={{ marginLeft: 6 }}>
            <path d="M1 7.5l4 4L13 2.5" stroke="#53bdeb" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M8 11.5l1.5 0L20 2.5" stroke="#53bdeb" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </div>
    </div>
  );

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          position: 'relative',
          background: '#0d1117',
          fontFamily: 'Inter, "Inter Ext"',
          fontWeight: 500,
          overflow: 'hidden',
        }}
      >
        {/* Glows + dotted world-ish pattern */}
        <div style={{ position: 'absolute', top: -330, left: 380, width: 1000, height: 760, display: 'flex', background: 'radial-gradient(circle at 50% 50%, rgba(124,58,237,0.34) 0%, rgba(124,58,237,0.12) 38%, rgba(124,58,237,0) 70%)' }} />
        <div style={{ position: 'absolute', bottom: -380, left: -260, width: 900, height: 760, display: 'flex', background: 'radial-gradient(circle at 50% 50%, rgba(37,211,102,0.26) 0%, rgba(37,211,102,0.09) 38%, rgba(37,211,102,0) 70%)' }} />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            backgroundImage: 'radial-gradient(rgba(148,163,184,0.18) 1.4px, transparent 1.4px)',
            backgroundSize: '26px 26px',
            opacity: 0.55,
          }}
        />

        {/* Left: brand + message */}
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 0 0 64px', width: 760, position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <img src={logoSrc} width={76} height={76} alt="" style={{ borderRadius: 999, boxShadow: '0 0 40px rgba(37,211,102,0.55)' }} />
            <div style={{ display: 'flex', fontSize: 46, fontWeight: 700, color: '#ffffff', letterSpacing: -1 }}>Flowza</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 28, fontSize: 56, fontWeight: 700, lineHeight: 1.1, letterSpacing: -1.5, color: '#ffffff' }}>
            <div style={{ display: 'flex' }}>Grow your business on</div>
            <div style={{ display: 'flex' }}>
              <span
                style={{
                  backgroundImage: 'linear-gradient(90deg, #6ee7b7, #25d366 55%, #a78bfa)',
                  backgroundClip: 'text',
                  color: 'transparent',
                  // Room for the last letter: the clip box is the advance width.
                  paddingRight: 8,
                  marginRight: -8,
                }}
              >
                WhatsApp
              </span>
              <span>, on autopilot.</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 28, maxWidth: 640 }}>
            {chip('Shared inbox')}
            {chip('Follow-up journeys')}
            {chip('Broadcasts')}
            {chip('AI replies')}
            {chip('UPI payments')}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 30 }}>
            <div style={{ display: 'flex', padding: '14px 26px', borderRadius: 16, background: '#25d366', color: '#05130b', fontSize: 26, fontWeight: 700 }}>
              Plans from ₹999/month
            </div>
            <div style={{ display: 'flex', color: '#9fb0c3', fontSize: 24 }}>Free live demo</div>
          </div>
        </div>

        {/* Right: phone-style chat */}
        <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              width: 400,
              borderRadius: 32,
              border: '1px solid rgba(255,255,255,0.12)',
              background: '#0b141a',
              boxShadow: '0 30px 80px rgba(0,0,0,0.55), 0 0 60px rgba(37,211,102,0.18)',
              overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', background: '#202c33' }}>
              <div style={{ display: 'flex', width: 40, height: 40, borderRadius: 999, background: 'rgba(37,211,102,0.25)', color: '#6ee7b7', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 700 }}>A</div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', color: '#ffffff', fontSize: 20, fontWeight: 600 }}>Asha Patil</div>
                <div style={{ display: 'flex', color: '#6ee7b7', fontSize: 15 }}>Automated by Flowza</div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 20 }}>
              {bubble('Your webinar is tonight at 8:00 PM', true, '2:00 PM')}
              {bubble('Can I join today?', false, '7:58 PM')}
              {bubble('Yes! Here’s your payment link', true, '7:58 PM')}
              {bubble('Paid. Thank you!', false, '8:03 PM')}
            </div>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: 'Inter', data: bold, weight: 700, style: 'normal' },
        { name: 'Inter', data: medium, weight: 500, style: 'normal' },
        // Separate family name: same-name fonts aren't used as fallbacks.
        { name: 'Inter Ext', data: boldExt, weight: 700, style: 'normal' },
        { name: 'Inter Ext', data: mediumExt, weight: 500, style: 'normal' },
      ],
    }
  );
}
