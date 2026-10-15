-- =============================================================================
--  LAZO-4 · RPC del lazo para el MCP de Railway (preparada, SIN aplicar)
--  Diseño: 05YUNQUE/docs/investigacion/prometeo-lazo-autonomo.md §4.1 (Tramo 3).
--  DEPENDE de LAZO-1 (05YUNQUE rama lazo-tramo1, db/2026-10-14_lazo_tramo1.sql):
--  yunque.lazos + plan_items.irreversible + settings.lazo_kill. Aplicar DESPUÉS.
--
--  yunque.yq_lanzar_lazo  — en UNA transacción: inserta plan_items (al final del plan),
--                           crea la fila yunque.lazos y enciende el autopilot.
--  yunque.yq_lazo_estado  — lectura: último lazo, forjas, avance, último lazo.paso.
--  yunque.yq_lazo_alto    — el freno: estado='alto' + piloto OFF + evento lazo.alto.
--  public.*               — wrappers SECURITY DEFINER para PostgREST (como yq_add_leccion);
--                           los que escriben exigen p_token → yunque.yq_check (mcp_auth).
--  Reversión: 2026-10-14_lazo4_rpc_down.sql
-- =============================================================================

-- Resuelve un proyecto vivo por UUID o por nombre (sin distinguir mayúsculas).
create or replace function yunque.yq_resolver_proyecto(p_proyecto text)
 returns uuid
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select id from yunque.projects
   where archived_at is null
     and (case when p_proyecto ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               then id = p_proyecto::uuid
               else lower(name) = lower(btrim(p_proyecto)) end)
   order by created_at desc
   limit 1;
$function$;

-- Heurística de irreversibles (Tramo 3): lo que sale hacia afuera o no se deshace va a
-- la bandeja aunque el chat no lo marque. Solo SUBE la marca, nunca la baja.
create or replace function yunque.lazo_es_irreversible(p_texto text)
 returns boolean
 language sql
 immutable
 set search_path to ''
as $function$
  select coalesce(p_texto, '') ~* (
    '(desplieg|despleg|redeploy|deploy|publica|push a main|push --force|force.push|'
    || 'producci|apply_migration|aplicar (la )?migraci|drop (table|column|schema)|truncate|'
    || 'borrar (la |el )?(base|tabla|repo)|enviar correo|send_message|app store|play store)');
$function$;

create or replace function yunque.yq_lanzar_lazo(
  p_proyecto   text,
  p_objetivo   text,
  p_items      jsonb,
  p_max_forjas integer default 12,
  p_max_horas  numeric default 8,
  p_origen     text    default 'chat')
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_pid     uuid;
  v_name    text;
  v_host    text;
  v_lazo    uuid;
  v_ord     integer;
  v_it      jsonb;
  v_title   text;
  v_detail  text;
  v_model   text;
  v_irrev   boolean;
  v_iid     uuid;
  v_out     jsonb := '[]'::jsonb;
  v_n       integer := 0;
  v_origen  text := coalesce(nullif(btrim(p_origen), ''), 'chat');
begin
  if coalesce(btrim(p_objetivo), '') = '' then
    return jsonb_build_object('error', 'Falta el objetivo del lazo');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('error', 'items debe ser una lista con al menos un paso');
  end if;
  if p_max_forjas is null or p_max_forjas < 1 then
    return jsonb_build_object('error', 'max_forjas debe ser >= 1');
  end if;
  if p_max_horas is null or p_max_horas <= 0 then
    return jsonb_build_object('error', 'max_horas debe ser > 0');
  end if;

  v_pid := yunque.yq_resolver_proyecto(p_proyecto);
  if v_pid is null then
    return jsonb_build_object('error', 'No hay ningun proyecto vivo que coincida con «' || coalesce(p_proyecto, '') || '»');
  end if;

  -- Bloquea el proyecto: dos lanzar_lazo simultáneos no se pisan.
  select name, host into v_name, v_host from yunque.projects where id = v_pid for update;
  if coalesce(v_host, '') = '' then
    return jsonb_build_object('error', 'El proyecto «' || v_name || '» no tiene host (máquina dueña): no se puede lanzar el lazo');
  end if;

  if exists (select 1 from yunque.lazos where project_id = v_pid and estado = 'corriendo') then
    return jsonb_build_object(
      'error', 'Ya hay un lazo corriendo en «' || v_name || '»: usa lazo_estado o lazo_alto antes de lanzar otro',
      'lazo_id', (select id from yunque.lazos where project_id = v_pid and estado = 'corriendo'));
  end if;
  if coalesce((select lazo_kill from yunque.settings order by id limit 1), false) then
    return jsonb_build_object('error', 'settings.lazo_kill está en true (palabra de alto global): no se lanza ningún lazo');
  end if;

  -- Validar TODOS los pasos antes de escribir nada.
  for v_it in select e from jsonb_array_elements(p_items) e loop
    v_n := v_n + 1;
    if jsonb_typeof(v_it) <> 'object' or coalesce(btrim(v_it->>'title'), '') = '' then
      return jsonb_build_object('error', 'Cada paso necesita title (paso ' || v_n || ')');
    end if;
    if nullif(btrim(v_it->>'model'), '') is not null
       and lower(btrim(v_it->>'model')) not in ('haiku', 'sonnet', 'opus') then
      return jsonb_build_object('error', 'model inválido en el paso ' || v_n || ': usa haiku | sonnet | opus');
    end if;
    if v_it ? 'irreversible' and jsonb_typeof(v_it->'irreversible') not in ('boolean', 'null') then
      return jsonb_build_object('error', 'irreversible debe ser true/false (paso ' || v_n || ')');
    end if;
  end loop;

  select coalesce(max(ordinal), 0) into v_ord from yunque.plan_items where project_id = v_pid;

  for v_it in select e from jsonb_array_elements(p_items) e loop
    v_ord    := v_ord + 1;
    v_title  := btrim(v_it->>'title');
    v_detail := nullif(btrim(v_it->>'detail'), '');
    v_model  := lower(nullif(btrim(v_it->>'model'), ''));
    v_irrev  := coalesce((v_it->>'irreversible')::boolean, false)
                or yunque.lazo_es_irreversible(v_title || ' ' || coalesce(v_detail, ''));
    insert into yunque.plan_items (project_id, title, detail, model, irreversible, ordinal)
    values (v_pid, v_title, v_detail, v_model, v_irrev, v_ord)
    returning id into v_iid;
    v_out := v_out || jsonb_build_object('id', v_iid, 'ordinal', v_ord, 'title', v_title,
                                         'model', v_model, 'irreversible', v_irrev);
  end loop;

  insert into yunque.lazos (project_id, host, objetivo, origen, max_forjas, max_horas)
  values (v_pid, v_host, btrim(p_objetivo), v_origen, p_max_forjas, p_max_horas)
  returning id into v_lazo;

  update yunque.projects
     set autopilot = true,
         autopilot_note = left('Lazo ' || v_lazo || ': ' || btrim(p_objetivo), 500),
         updated_at = now()
   where id = v_pid;

  perform yunque.log_event('lazo.inicio',
    '🟠 Lazo lanzado en «' || v_name || '»: ' || v_n || ' pasos (tope ' || p_max_forjas
      || ' forjas / ' || p_max_horas || ' h). Objetivo: ' || btrim(p_objetivo),
    'info', 'mcp',
    jsonb_build_object('lazo_id', v_lazo, 'pasos', v_out, 'max_forjas', p_max_forjas,
                       'max_horas', p_max_horas, 'origen', v_origen),
    v_pid, null, null, false);

  return jsonb_build_object('ok', true, 'lazo_id', v_lazo, 'project_id', v_pid, 'proyecto', v_name,
                            'host', v_host, 'estado', 'corriendo', 'autopilot', true,
                            'max_forjas', p_max_forjas, 'max_horas', p_max_horas, 'pasos', v_out);
end;
$function$;

create or replace function yunque.yq_lazo_estado(p_proyecto text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_pid   uuid;
  v_name  text;
  v_ap    boolean;
  v_lazo  record;
  v_paso  jsonb;
  v_av    jsonb;
begin
  v_pid := yunque.yq_resolver_proyecto(p_proyecto);
  if v_pid is null then
    return jsonb_build_object('error', 'No hay ningun proyecto vivo que coincida con «' || coalesce(p_proyecto, '') || '»');
  end if;
  select name, autopilot into v_name, v_ap from yunque.projects where id = v_pid;

  select * into v_lazo from yunque.lazos where project_id = v_pid
   order by (estado = 'corriendo') desc, started_at desc limit 1;
  if not found then
    return jsonb_build_object('project_id', v_pid, 'proyecto', v_name, 'autopilot', v_ap,
                              'lazo', null, 'nota', 'Este proyecto nunca ha tenido un lazo.');
  end if;

  select jsonb_build_object('fecha', e.created_at, 'resumen', e.summary, 'detalle', e.detail)
    into v_paso
    from yunque.events e
   where e.project_id = v_pid and e.kind = 'lazo.paso' and e.created_at >= v_lazo.started_at
   order by e.created_at desc limit 1;

  select jsonb_build_object(
           'total', count(*),
           'hechos', count(*) filter (where done_at is not null),
           'en_bandeja', count(*) filter (where done_at is null and awaiting_approval is not null),
           'irreversibles_pendientes', count(*) filter (where done_at is null and irreversible))
    into v_av
    from yunque.plan_items where project_id = v_pid;

  return jsonb_build_object(
    'project_id', v_pid, 'proyecto', v_name, 'autopilot', v_ap,
    'lazo_kill', coalesce((select lazo_kill from yunque.settings order by id limit 1), false),
    'lazo', jsonb_build_object(
      'id', v_lazo.id, 'estado', v_lazo.estado, 'objetivo', v_lazo.objetivo, 'origen', v_lazo.origen,
      'forjas', v_lazo.forjas, 'max_forjas', v_lazo.max_forjas,
      'horas', round((extract(epoch from (coalesce(v_lazo.ended_at, now()) - v_lazo.started_at)) / 3600.0)::numeric, 2),
      'max_horas', v_lazo.max_horas, 'started_at', v_lazo.started_at,
      'ended_at', v_lazo.ended_at, 'motivo_fin', v_lazo.motivo_fin),
    'avance', v_av,
    'ultimo_paso', v_paso,
    'resumen', 'Lazo ' || v_lazo.estado || ' · ' || v_lazo.forjas || '/' || v_lazo.max_forjas || ' forjas · '
               || (v_av->>'hechos') || '/' || (v_av->>'total') || ' partidas hechas');
end;
$function$;

create or replace function yunque.yq_lazo_alto(p_proyecto text, p_motivo text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_pid    uuid;
  v_name   text;
  v_lazo   uuid;
  v_forjas integer;
  v_motivo text := coalesce(nullif(btrim(p_motivo), ''), 'ALTO de Cesar (desde el chat)');
begin
  v_pid := yunque.yq_resolver_proyecto(p_proyecto);
  if v_pid is null then
    return jsonb_build_object('error', 'No hay ningun proyecto vivo que coincida con «' || coalesce(p_proyecto, '') || '»');
  end if;
  select name into v_name from yunque.projects where id = v_pid for update;

  update yunque.lazos
     set estado = 'alto', ended_at = now(), motivo_fin = v_motivo
   where project_id = v_pid and estado = 'corriendo'
  returning id, forjas into v_lazo, v_forjas;

  -- El freno apaga el piloto del proyecto aunque no hubiera lazo corriendo (ALTO es ALTO).
  update yunque.projects
     set autopilot = false,
         autopilot_note = left('ALTO: ' || v_motivo, 500),
         updated_at = now()
   where id = v_pid;

  perform yunque.log_event('lazo.alto',
    '⛔ ALTO en «' || v_name || '»: ' || v_motivo
      || case when v_lazo is null then ' (no había lazo corriendo; piloto apagado)'
              else ' (lazo detenido tras ' || v_forjas || ' forjas)' end,
    'warn', 'mcp',
    jsonb_strip_nulls(jsonb_build_object('lazo_id', v_lazo, 'motivo', v_motivo, 'forjas', v_forjas)),
    v_pid, null, null, false);

  return jsonb_build_object(
    'ok', true, 'project_id', v_pid, 'proyecto', v_name, 'lazo_id', v_lazo,
    'estado', case when v_lazo is null then null else 'alto' end,
    'autopilot', false,
    'nota', case when v_lazo is null then 'No había lazo corriendo; el piloto quedó apagado igual.'
                 else 'Lazo en alto. El job que esté corriendo termina su paso; no se forja nada más.' end);
end;
$function$;

-- ---------------- wrappers public (PostgREST) ----------------
create or replace function public.yq_lanzar_lazo(
  p_token text, p_proyecto text, p_objetivo text, p_items jsonb,
  p_max_forjas integer default 12, p_max_horas numeric default 8, p_origen text default 'chat')
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  perform yunque.yq_check(p_token);
  return yunque.yq_lanzar_lazo(p_proyecto, p_objetivo, p_items, p_max_forjas, p_max_horas, p_origen);
end; $function$;

create or replace function public.yq_lazo_estado(p_proyecto text)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $function$ select yunque.yq_lazo_estado(p_proyecto); $function$;

create or replace function public.yq_lazo_alto(p_token text, p_proyecto text, p_motivo text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  perform yunque.yq_check(p_token);
  return yunque.yq_lazo_alto(p_proyecto, p_motivo);
end; $function$;

-- Las internas que escriben, solo por los wrappers; los wrappers, para el MCP.
revoke all on function yunque.yq_lanzar_lazo(text, text, jsonb, integer, numeric, text) from public, anon, authenticated;
revoke all on function yunque.yq_lazo_alto(text, text) from public, anon, authenticated;
revoke all on function public.yq_lanzar_lazo(text, text, text, jsonb, integer, numeric, text) from public;
revoke all on function public.yq_lazo_alto(text, text, text) from public;
grant execute on function public.yq_lanzar_lazo(text, text, text, jsonb, integer, numeric, text) to anon, authenticated, service_role;
grant execute on function public.yq_lazo_estado(text) to anon, authenticated, service_role;
grant execute on function public.yq_lazo_alto(text, text, text) to anon, authenticated, service_role;
