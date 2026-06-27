-- Tilfoej fulde makroer til recipes, saa hele splittet kan gemmes og vises -
-- ikke kun kcal + protein. Maal-split (Gustavs valg 2026-06-27): ca. 40%
-- kulhydrat / 30% protein / 30% fedt, med protein holdt HOEJT i gram.
-- Kør HELE filen i Supabase SQL Editor (projekt dxowfjyigfrhyaixyonj).
alter table recipes
  add column if not exists carbs_g int,   -- kulhydrat (g) for HELE retten
  add column if not exists fat_g   int;   -- fedt (g) for HELE retten

notify pgrst, 'reload schema';
