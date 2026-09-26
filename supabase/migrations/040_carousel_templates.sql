-- Migration 040: Add Product Card Carousel fields to message_templates
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS template_type TEXT DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS carousel JSONB;

COMMENT ON COLUMN message_templates.template_type IS 'Template type: standard (header/body/footer) or carousel (multi-card product carousel)';
COMMENT ON COLUMN message_templates.carousel IS 'Array of CarouselCard objects for carousel templates';
