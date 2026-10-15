# LAZO-4 · Desplegar `lanzar_lazo` / `lazo_estado` / `lazo_alto` — runbook (requiere OK de Cesar)

Rama: `lazo4-lanzar-lazo` (commits locales, **sin push**). Nada de esto está vivo.
El push a `main` de `CRFong81/yunque-mcp` **redespliega Railway solo**: es la parte
irreversible y la aprueba Cesar.

## Orden (no se puede invertir)

1. **LAZO-1 en la base** (05YUNQUE, rama `lazo-tramo1`):
   `db/2026-10-14_lazo_tramo1.sql` → crea `yunque.lazos`, `plan_items.irreversible`,
   `settings.lazo_kill`, trigger `lazo.paso`. Hoy **NO está aplicada** (verificado
   14-oct: `to_regclass('yunque.lazos') = null`). Se aplica con su script
   `scripts/lazo_tramo1_db.py aplicar` / `activar-lazo-tramo1.ps1` (LAZO-1).
   Sin el auto-piloto de LAZO-2 el lazo se crea pero **nadie mira sus frenos** salvo
   `lazo_alto` (que apaga el piloto del proyecto directamente).
2. **RPC de LAZO-4 en la base**: `db/2026-10-14_lazo4_rpc.sql` (apply_migration o psql).
   Antes, repetir la prueba: `python db/run_test_lazo4.py` (sin `--lazo1` si LAZO-1 ya
   está aplicada) → debe imprimir `LAZO4_TEST_OK casos [1 2 3 4 5 6 7 8 9]` y EXIT 0.
   Reversión: `db/2026-10-14_lazo4_rpc_down.sql`.
3. **Server**: `npm test` verde → merge de `lazo4-lanzar-lazo` a `main` → push →
   Railway redespliega. Verificar: `GET /` lista `lanzar_lazo, lazo_estado, lazo_alto`.
4. **Prueba de humo desde claude.ai** sobre `PRUEBA-LOOP` (nunca contra la cola viva de
   un proyecto real): `lazo_estado PRUEBA-LOOP` → `lanzar_lazo` de 1 paso trivial →
   `lazo_alto PRUEBA-LOOP` → `lazo_estado` muestra `alto`.

Si el server se despliega ANTES que las RPC, las tres tools fallan con
`yq_lanzar_lazo: 404 …` (PostgREST no encuentra la función) — no rompe las demás tools.
