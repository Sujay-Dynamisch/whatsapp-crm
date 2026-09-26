import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import type { CarouselCard } from '@/types'

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const { supabase, accountId } = await requireRole('agent')

    const body = await request.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

    const { data: existing } = await supabase
      .from('carousel_configs')
      .select('template_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()

    const updates: Record<string, unknown> = {}
    if (typeof body.name === 'string') updates.name = body.name.trim()
    if (body.carousel_type === 'PRODUCT' || body.carousel_type === 'MEDIA') updates.carousel_type = body.carousel_type
    if ('template_id' in body) updates.template_id = body.template_id || null
    if (Array.isArray(body.cards)) updates.cards = body.cards
    updates.updated_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('carousel_configs')
      .update(updates)
      .eq('id', id)
      .eq('account_id', accountId)
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const newTemplateId = 'template_id' in updates ? (updates.template_id as string | null) : existing?.template_id
    const newCards = 'cards' in updates ? (updates.cards as CarouselCard[]) : data.cards

    if (newTemplateId) {
      await supabase
        .from('message_templates')
        .update({
          template_type: 'carousel',
          carousel: newCards,
        })
        .eq('id', newTemplateId)
        .eq('account_id', accountId)
    }

    if (existing?.template_id && existing.template_id !== newTemplateId) {
      const { data: remaining } = await supabase
        .from('carousel_configs')
        .select('id')
        .eq('template_id', existing.template_id)
        .maybeSingle()
      if (!remaining) {
        await supabase
          .from('message_templates')
          .update({
            template_type: 'standard',
            carousel: null,
          })
          .eq('id', existing.template_id)
          .eq('account_id', accountId)
      }
    }

    return NextResponse.json({ carousel: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const { supabase, accountId } = await requireRole('agent')

    const { data: existing } = await supabase
      .from('carousel_configs')
      .select('template_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()

    const { error } = await supabase
      .from('carousel_configs')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    if (existing?.template_id) {
      const { data: remaining } = await supabase
        .from('carousel_configs')
        .select('id')
        .eq('template_id', existing.template_id)
        .maybeSingle()
      if (!remaining) {
        await supabase
          .from('message_templates')
          .update({
            template_type: 'standard',
            carousel: null,
          })
          .eq('id', existing.template_id)
          .eq('account_id', accountId)
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
