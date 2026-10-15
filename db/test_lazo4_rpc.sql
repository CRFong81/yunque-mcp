-- =============================================================================
--  Test de LAZO-4 contra la base REAL, sin dejar rastro.
--  Uso: concatenar  [LAZO-1 si no está aplicada] + 2026-10-14_lazo4_rpc.sql + este archivo
--  y correrlo como UN solo lote (psql -1 / execute_sql). El bloque final SIEMPRE termina en
--  RAISE EXCEPTION: con 'LAZO4_TEST_OK ...' si todo pasó (=> rollback garantizado) o con la
--  aserción que falló. Nada se commitea nunca. Trabaja sobre un proyecto temporal.
-- =============================================================================
set local lock_timeout = '3s';

do $test$
declare
  v_tok   text := (select token from yunque.mcp_auth where id = 1);
  v_pid   uuid;
  v_arch  uuid;
  v_nohost uuid;
  v_name  text := 'zz-lazo4-test-' || substr(md5(random()::text), 1, 8);
  r       jsonb;
  v_lazo  uuid;
  v_n     integer;
  v_log   text := '';
  v_err   text;
begin
  insert into yunque.projects (name, host, autopilot) values (v_name, 'TEST-HOST', false) returning id into v_pid;
  insert into yunque.projects (name, host, archived_at) values (v_name || '-arch', 'TEST-HOST', now()) returning id into v_arch;
  insert into yunque.projects (name, host) values (v_name || '-nohost', null) returning id into v_nohost;

  -- 1. token malo → No autorizado
  begin
    perform public.yq_lanzar_lazo('token-falso', v_name, 'x', '[{"title":"a"}]'::jsonb);
    raise exception 'FALLA 1: lanzar_lazo aceptó un token falso';
  exception when others then
    if sqlerrm not like '%No autorizado%' then raise; end if;
  end;
  v_log := v_log || '1 ';

  -- 2. lanzar bien: 3 pasos, heurística de irreversibles, modelo normalizado
  r := public.yq_lanzar_lazo(v_tok, upper(v_name), 'Objetivo de prueba',
    '[{"title":"Paso uno","detail":"crear tabla","model":"OPUS"},
      {"title":"Paso dos","detail":"redeploy de Railway"},
      {"title":"Paso tres","irreversible":true,"model":"haiku"}]'::jsonb, 5, 2);
  if not coalesce((r->>'ok')::boolean, false) then raise exception 'FALLA 2: %', r; end if;
  v_lazo := (r->>'lazo_id')::uuid;
  select count(*) into v_n from yunque.plan_items where project_id = v_pid;
  if v_n <> 3 then raise exception 'FALLA 2a: % plan_items', v_n; end if;
  if (select string_agg(ordinal || ':' || coalesce(model, '-') || ':' || irreversible, ',' order by ordinal)
        from yunque.plan_items where project_id = v_pid) <> '1:opus:false,2:-:true,3:haiku:true' then
    raise exception 'FALLA 2b: partidas %', (select json_agg(p) from yunque.plan_items p where project_id = v_pid);
  end if;
  if not exists (select 1 from yunque.lazos where id = v_lazo and project_id = v_pid and estado = 'corriendo'
                 and host = 'TEST-HOST' and max_forjas = 5 and max_horas = 2 and objetivo = 'Objetivo de prueba') then
    raise exception 'FALLA 2c: fila lazos';
  end if;
  if not (select autopilot from yunque.projects where id = v_pid) then raise exception 'FALLA 2d: autopilot apagado'; end if;
  if not exists (select 1 from yunque.events where project_id = v_pid and kind = 'lazo.inicio') then
    raise exception 'FALLA 2e: sin evento lazo.inicio';
  end if;
  v_log := v_log || '2 ';

  -- 3. segundo lazo mientras corre → error, sin partidas nuevas
  r := public.yq_lanzar_lazo(v_tok, v_name, 'otro', '[{"title":"x"}]'::jsonb);
  if r->>'error' not like 'Ya hay un lazo corriendo%' then raise exception 'FALLA 3: %', r; end if;
  -- 4. validación: modelo inválido / sin title / lista vacía / topes → error y nada escrito
  r := yunque.yq_lanzar_lazo(v_name || '-nohost', 'o', '[{"title":"a"}]'::jsonb);
  if r->>'error' not like '%no tiene host%' then raise exception 'FALLA 4a: %', r; end if;
  update yunque.lazos set estado = 'terminado' where id = v_lazo;  -- liberar para validar
  r := yunque.yq_lanzar_lazo(v_name, 'o', '[{"title":"a","model":"gpt"}]'::jsonb);
  if r->>'error' not like 'model inválido%' then raise exception 'FALLA 4b: %', r; end if;
  r := yunque.yq_lanzar_lazo(v_name, 'o', '[{"title":"a"},{"detail":"sin titulo"}]'::jsonb);
  if r->>'error' not like '%paso 2%' then raise exception 'FALLA 4c: %', r; end if;
  r := yunque.yq_lanzar_lazo(v_name, 'o', '[]'::jsonb);
  if r->>'error' is null then raise exception 'FALLA 4d: %', r; end if;
  r := yunque.yq_lanzar_lazo(v_name, 'o', '[{"title":"a"}]'::jsonb, 0);
  if r->>'error' is null then raise exception 'FALLA 4e: %', r; end if;
  r := yunque.yq_lanzar_lazo(v_name, '  ', '[{"title":"a"}]'::jsonb);
  if r->>'error' is null then raise exception 'FALLA 4f: %', r; end if;
  r := yunque.yq_lanzar_lazo(v_name || '-arch', 'o', '[{"title":"a"}]'::jsonb);
  if r->>'error' not like 'No hay ningun proyecto%' then raise exception 'FALLA 4g (archivado): %', r; end if;
  r := yunque.yq_lanzar_lazo('no-existe-' || v_name, 'o', '[{"title":"a"}]'::jsonb);
  if r->>'error' not like 'No hay ningun proyecto%' then raise exception 'FALLA 4h: %', r; end if;
  select count(*) into v_n from yunque.plan_items where project_id = v_pid;
  if v_n <> 3 then raise exception 'FALLA 4i: una validación escribió partidas (%)', v_n; end if;
  update yunque.lazos set estado = 'corriendo' where id = v_lazo;
  v_log := v_log || '3 4 ';

  -- 5. lazo_estado: corriendo, avance, y último lazo.paso tras tachar una partida
  r := public.yq_lazo_estado(v_pid::text);
  if r->'lazo'->>'estado' <> 'corriendo' or (r->'avance'->>'total')::int <> 3
     or (r->'avance'->>'irreversibles_pendientes')::int <> 2 or r->'ultimo_paso' <> 'null'::jsonb and r->'ultimo_paso' is not null then
    raise exception 'FALLA 5a: %', r;
  end if;
  update yunque.lazos set started_at = now() - interval '1 minute' where id = v_lazo;
  update yunque.plan_items set done_at = now() where project_id = v_pid and ordinal = 1;
  r := public.yq_lazo_estado(v_name);
  if (r->'avance'->>'hechos')::int <> 1 or r->'ultimo_paso'->>'resumen' not like '%Paso 1/3%' then
    raise exception 'FALLA 5b: %', r;
  end if;
  r := public.yq_lazo_estado('no-existe-' || v_name);
  if r->>'error' is null then raise exception 'FALLA 5c: %', r; end if;
  v_log := v_log || '5 ';

  -- 6. lazo_alto: token malo → No autorizado; bueno → alto + piloto OFF + evento
  begin
    perform public.yq_lazo_alto(null, v_name);
    raise exception 'FALLA 6: lazo_alto aceptó token nulo';
  exception when others then
    if sqlerrm not like '%No autorizado%' then raise; end if;
  end;
  r := public.yq_lazo_alto(v_tok, v_name, 'ALTO de prueba');
  if (r->>'lazo_id')::uuid is distinct from v_lazo or r->>'estado' <> 'alto' then raise exception 'FALLA 6a: %', r; end if;
  if (select autopilot from yunque.projects where id = v_pid) then raise exception 'FALLA 6b: piloto sigue encendido'; end if;
  if not exists (select 1 from yunque.lazos where id = v_lazo and estado = 'alto' and ended_at is not null
                 and motivo_fin = 'ALTO de prueba') then raise exception 'FALLA 6c'; end if;
  if not exists (select 1 from yunque.events where project_id = v_pid and kind = 'lazo.alto') then
    raise exception 'FALLA 6d: sin evento lazo.alto';
  end if;
  r := public.yq_lazo_estado(v_name);
  if r->'lazo'->>'estado' <> 'alto' or r->'lazo'->>'motivo_fin' <> 'ALTO de prueba' then raise exception 'FALLA 6e: %', r; end if;
  -- 7. ALTO sin lazo corriendo: no rompe, apaga el piloto igual
  r := public.yq_lazo_alto(v_tok, v_name);
  if not (r->>'ok')::boolean or r->>'lazo_id' is not null then raise exception 'FALLA 7: %', r; end if;
  v_log := v_log || '6 7 ';

  -- 8. tras el alto se puede lanzar otro lazo (el índice único solo mira 'corriendo')
  r := public.yq_lanzar_lazo(v_tok, v_name, 'segunda vuelta', '[{"title":"Paso cuatro"}]'::jsonb);
  if not coalesce((r->>'ok')::boolean, false) or (r->'pasos'->0->>'ordinal')::int <> 4 then
    raise exception 'FALLA 8: %', r;
  end if;
  v_log := v_log || '8 ';

  -- 9. permisos: anon puede llamar los wrappers, no las internas que escriben
  if not has_function_privilege('anon', 'public.yq_lanzar_lazo(text,text,text,jsonb,integer,numeric,text)', 'execute')
     or not has_function_privilege('anon', 'public.yq_lazo_estado(text)', 'execute')
     or not has_function_privilege('anon', 'public.yq_lazo_alto(text,text,text)', 'execute') then
    raise exception 'FALLA 9a: anon sin execute en los wrappers';
  end if;
  if has_function_privilege('anon', 'yunque.yq_lanzar_lazo(text,text,jsonb,integer,numeric,text)', 'execute')
     or has_function_privilege('anon', 'yunque.yq_lazo_alto(text,text)', 'execute') then
    raise exception 'FALLA 9b: anon puede llamar las internas sin token';
  end if;
  v_log := v_log || '9';

  raise exception 'LAZO4_TEST_OK casos [%] — rollback forzado, nada quedó escrito', v_log;
end
$test$;
