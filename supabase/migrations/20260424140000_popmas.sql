-- Deduped master catalog: union of POP038, POP072, POP074, POP230, POP351, POP400, POP529.
-- One row per normalized (Name, Size, Price, imageUrl); keeps highest score per key.

create table if not exists public."POPMAS" (
  id bigint generated always as identity primary key,
  "imageUrl" text,
  "Name" text,
  "Size" text,
  "Price" text,
  "Formatted PPU" text,
  score double precision,
  "Recommended Quantity" bigint,
  "Category" text,
  "Other Category 1" text,
  "Other Category 2" text,
  "Product Type" text,
  "Product Type Rec Count" bigint,
  "Offers" text,
  "Grouping" text,
  "Type" text,
  "Model" text
);

alter table public."POPMAS" enable row level security;

drop policy if exists "Enable read access for all users" on public."POPMAS";

create policy "Enable read access for all users"
  on public."POPMAS"
  for select
  using (true);

comment on table public."POPMAS" is 'Master deduped product list merged from POP* source tables.';

do $$
begin
  if exists (select 1 from public."POPMAS" limit 1) then
    return;
  end if;

  insert into public."POPMAS" (
    "imageUrl",
    "Name",
    "Size",
    "Price",
    "Formatted PPU",
    score,
    "Recommended Quantity",
    "Category",
    "Other Category 1",
    "Other Category 2",
    "Product Type",
    "Product Type Rec Count",
    "Offers",
    "Grouping",
    "Type",
    "Model"
  )
  select distinct on (
    lower(trim(coalesce("Name", ''))),
    lower(trim(coalesce("Size", ''))),
    lower(trim(coalesce("Price", ''))),
    lower(trim(coalesce("imageUrl", '')))
  )
    "imageUrl",
    "Name",
    "Size",
    "Price",
    "Formatted PPU",
    score,
    "Recommended Quantity",
    "Category",
    "Other Category 1",
    "Other Category 2",
    "Product Type",
    "Product Type Rec Count",
    "Offers",
    "Grouping",
    "Type",
    "Model"
  from (
    select
      "imageUrl", "Name", "Size", "Price", "Formatted PPU", score, "Recommended Quantity",
      "Category", "Other Category 1", "Other Category 2", "Product Type", "Product Type Rec Count",
      "Offers", "Grouping", "Type", "Model"
    from public."POP038"
    union all
    select
      "imageUrl", "Name", "Size", "Price", "Formatted PPU", score, "Recommended Quantity",
      "Category", "Other Category 1", "Other Category 2", "Product Type", "Product Type Rec Count",
      "Offers", "Grouping", "Type", "Model"
    from public."POP072"
    union all
    select
      "imageUrl", "Name", "Size", "Price", "Formatted PPU", score, "Recommended Quantity",
      "Category", "Other Category 1", "Other Category 2", "Product Type", "Product Type Rec Count",
      "Offers", "Grouping", "Type", "Model"
    from public."POP074"
    union all
    select
      "imageUrl", "Name", "Size", "Price", "Formatted PPU", score, "Recommended Quantity",
      "Category", "Other Category 1", "Other Category 2", "Product Type", "Product Type Rec Count",
      "Offers", "Grouping", "Type", "Model"
    from public."POP230"
    union all
    select
      "imageUrl", "Name", "Size", "Price", "Formatted PPU", score, "Recommended Quantity",
      "Category", "Other Category 1", "Other Category 2", "Product Type", "Product Type Rec Count",
      "Offers", "Grouping", "Type", "Model"
    from public."POP351"
    union all
    select
      "imageUrl", "Name", "Size", "Price", "Formatted PPU", score, "Recommended Quantity",
      "Category", "Other Category 1", "Other Category 2", "Product Type", "Product Type Rec Count",
      "Offers", "Grouping", "Type", "Model"
    from public."POP400"
    union all
    select
      "imageUrl", "Name", "Size", "Price", "Formatted PPU", score, "Recommended Quantity",
      "Category", "Other Category 1", "Other Category 2", "Product Type", "Product Type Rec Count",
      "Offers", "Grouping", "Type", "Model"
    from public."POP529"
  ) u
  order by
    lower(trim(coalesce("Name", ''))),
    lower(trim(coalesce("Size", ''))),
    lower(trim(coalesce("Price", ''))),
    lower(trim(coalesce("imageUrl", ''))),
    score desc nulls last,
    "Name" nulls last;
end $$;
