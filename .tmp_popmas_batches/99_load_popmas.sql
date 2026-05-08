TRUNCATE TABLE public."POPMAS" RESTART IDENTITY;
INSERT INTO public."POPMAS" (
  "imageUrl", "Name", "Size", "Price", "Formatted PPU", "Category", "Other Category 1", "Other Category 2", "Product Type", "Offers", "Range", "product_popularity"
)
SELECT
  "imageUrl", "Name", "Size", "Price", "Formatted PPU", "Category", "Other Category 1", "Other Category 2", "Product Type", "Offers", "Range", "product_popularity"
FROM public.popmas_import_staging
ORDER BY "product_popularity" DESC NULLS LAST;
