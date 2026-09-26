import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('carousel_configs')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ carousels: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const body = await request.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const carousel_type = body.carousel_type === 'MEDIA' ? 'MEDIA' : 'PRODUCT'
    const template_id = body.template_id || null
    const cards = Array.isArray(body.cards) ? body.cards : []

    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    if (cards.length < 2) {
      return NextResponse.json({ error: 'Carousel requires at least 2 cards' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('carousel_configs')
      .insert({
        account_id: accountId,
        user_id: userId,
        name,
        carousel_type,
        template_id,
        cards,
      })
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    if (template_id) {
      await supabase
        .from('message_templates')
        .update({
          template_type: 'carousel',
          carousel: cards,
        })
        .eq('id', template_id)
        .eq('account_id', accountId)
    }

    return NextResponse.json({ carousel: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
