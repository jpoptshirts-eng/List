SELECT COUNT(*)::bigint AS row_count, MIN("product_popularity") AS min_product_popularity, MAX("product_popularity") AS max_product_popularity FROM public."POPMAS";
SELECT "Name", "product_popularity", "Range" FROM public."POPMAS" ORDER BY "product_popularity" DESC NULLS LAST, "id" ASC LIMIT 5;
