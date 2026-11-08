-- Create carousel_configs table for managing send-time WhatsApp Carousel cards
CREATE TABLE IF NOT EXISTS public.carousel_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  carousel_type TEXT NOT NULL DEFAULT 'PRODUCT', -- 'PRODUCT' | 'MEDIA'
  template_id UUID REFERENCES public.message_templates(id) ON DELETE SET NULL,
  cards JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for tenancy lookups
CREATE INDEX IF NOT EXISTS idx_carousel_configs_account_id ON public.carousel_configs(account_id);
CREATE INDEX IF NOT EXISTS idx_carousel_configs_template_id ON public.carousel_configs(template_id);

-- Enable RLS
ALTER TABLE public.carousel_configs ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view carousel configs in their account"
  ON public.carousel_configs FOR SELECT
  USING (account_id IN (
    SELECT account_id FROM public.profiles WHERE user_id = auth.uid()
  ));

CREATE POLICY "Users can insert carousel configs in their account"
  ON public.carousel_configs FOR INSERT
  WITH CHECK (account_id IN (
    SELECT account_id FROM public.profiles WHERE user_id = auth.uid()
  ));

CREATE POLICY "Users can update carousel configs in their account"
  ON public.carousel_configs FOR UPDATE
  USING (account_id IN (
    SELECT account_id FROM public.profiles WHERE user_id = auth.uid()
  ));

CREATE POLICY "Users can delete carousel configs in their account"
  ON public.carousel_configs FOR DELETE
  USING (account_id IN (
    SELECT account_id FROM public.profiles WHERE user_id = auth.uid()
  ));
