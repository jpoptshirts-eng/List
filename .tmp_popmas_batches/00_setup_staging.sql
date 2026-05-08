CREATE TABLE IF NOT EXISTS public.popmas_import_staging (
  "imageUrl" text,
  "Name" text,
  "Size" text,
  "Price" text,
  "Formatted PPU" text,
  "Category" text,
  "Other Category 1" text,
  "Other Category 2" text,
  "Product Type" text,
  "Offers" text,
  "Range" text,
  "product_popularity" bigint
);
TRUNCATE TABLE public.popmas_import_staging;
