// GET /api/webinars/gap — "add the next session" state for the header
// warning and the Webinars page (src/lib/webinars/gap.ts). Webinar access.
import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { webinarGap } from '@/lib/webinars/gap';
import { requireWebinarAccess } from '@/lib/webinars/server';

export async function GET() {
  try {
    const { admin, accountId } = await requireWebinarAccess('view');
    return NextResponse.json(await webinarGap(admin, accountId));
  } catch (error) {
    return toErrorResponse(error);
  }
}
