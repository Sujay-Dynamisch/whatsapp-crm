import { describe, expect, it } from 'vitest';

import { toWhatsAppFormat } from './whatsapp-format';

describe('toWhatsAppFormat', () => {
  it('converts Markdown bold, headings, strike and links', () => {
    expect(toWhatsAppFormat('**✅ Callback**')).toBe('*✅ Callback*');
    expect(toWhatsAppFormat('## Ready to join?')).toBe('*Ready to join?*');
    expect(toWhatsAppFormat('~~old~~ new')).toBe('~old~ new');
    expect(toWhatsAppFormat('[Pay here](https://rzp.io/x)')).toBe('Pay here: https://rzp.io/x');
  });
  it('turns * / + bullets into • and keeps - bullets and WhatsApp formatting', () => {
    expect(toWhatsAppFormat('* one\n+ two\n- three')).toBe('• one\n• two\n- three');
    expect(toWhatsAppFormat('Hi *Asha*, _thanks_')).toBe('Hi *Asha*, _thanks_');
  });
  it('fixes "- **Label:** value" lists the AI agent writes', () => {
    expect(toWhatsAppFormat('- **Duration:** 8 weeks
- **Format:** Live online')).toBe('- *Duration:* 8 weeks
- *Format:* Live online');
  });
  it('leaves code blocks alone', () => {
    expect(toWhatsAppFormat('```**x**```')).toBe('```**x**```');
  });
});
