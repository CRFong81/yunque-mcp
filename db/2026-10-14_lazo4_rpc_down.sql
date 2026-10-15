-- Reversión de LAZO-4 (no toca yunque.lazos / plan_items.irreversible: eso es LAZO-1).
drop function if exists public.yq_lanzar_lazo(text, text, text, jsonb, integer, numeric, text);
drop function if exists public.yq_lazo_estado(text);
drop function if exists public.yq_lazo_alto(text, text, text);
drop function if exists yunque.yq_lanzar_lazo(text, text, jsonb, integer, numeric, text);
drop function if exists yunque.yq_lazo_estado(text);
drop function if exists yunque.yq_lazo_alto(text, text);
drop function if exists yunque.lazo_es_irreversible(text);
drop function if exists yunque.yq_resolver_proyecto(text);
