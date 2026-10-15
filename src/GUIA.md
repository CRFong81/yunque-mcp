# GUÍA DE YUNQUE — briefing para cualquier coworker

> Esta es la **fuente de verdad única** de "qué es Yunque y cómo se usa" para
> cualquier asistente (coworker) que se conecte al MCP. Léela apenas te conectes.
> La devuelve entera la herramienta MCP **`guia`** (sin argumentos). Si trabajas
> dentro del repo, el detalle exhaustivo vive en [`docs/`](EXPEDIENTE.md) y las
> reglas de gobierno en [`.specify/constitution.md`](../.specify/constitution.md).

---

## 1 · Qué es Yunque

**Yunque es una fábrica de software autónoma** (una "fragua"): un motor que convierte
tareas en *jobs* ejecutados por **Claude Code headless (`claude -p`) sobre repos
reales**. Es una herramienta interna de **Dynamic Panama Builders**, operada por
**Cesar Fong**.

- **Claude corre por la SUSCRIPCIÓN del CLI de Cesar, NUNCA por API key.**
  `ANTHROPIC_API_KEY` queda vacía a propósito; no hay límite de gasto por diseño.
  (Única excepción: el "disparador", un servicio opcional apagado por defecto que sí
  usa API por token con su propio presupuesto.)
- **El estado vive en una sola fuente de verdad: Postgres/Supabase, schema `yunque`.**
  Nadie usa la API REST de Supabase; todos se conectan por Postgres directo con
  `YUNQUE_DB_URL`. Los procesos no se hablan entre sí: se coordinan escribiendo y
  leyendo la base.

Cinco componentes:

| Componente | Qué es | Dónde |
|---|---|---|
| **Worker** | Ejecuta jobs: corre `claude -p` en el repo. Hasta N en paralelo, uno por repo. Antes de cerrar `done`, se auto-verifica con el "temple". | `worker/yunque_worker.py` (Python) |
| **Auto-piloto** | El cerebro: planea proyectos enteros, forja las partidas en orden, sana fisuras, dirige el plan entre MPs. | `worker/yunque_autopilot.py` (Python) |
| **MCP server** | Expone la cola como herramientas MCP + API REST + sirve la PWA. **Esto es lo que estás usando ahora.** | `mcp/` (TypeScript/Node, puerto 47700) |
| **Desktop** | "Mission Control": cabina de mando Electron; embebe worker y auto-piloto. | `desktop/` (Electron) |
| **PWA móvil** | App instalable (Flota/Tareas/Aprobar/Proyectos), servida por el MCP en `/app`. | `mcp/public/` |

**La metáfora recorre todo el código y la UI** — consérvala al escribir cosas nuevas:
*forjar* = ejecutar una unidad de trabajo · *partida* = unidad de trabajo del plan ·
*fisura* = un job que falló · *flota* = los jobs · *fragua* = la máquina que corre el
MCP · *al rojo* = job corriendo · *temple* = la auto-verificación.

---

## 2 · Cómo funciona el ciclo

```
forjar (encolar job) → el worker corre Claude Code en el repo → TEMPLE (inspector
independiente verifica) → se emite EVIDENCIA estructurada al cerrar → done | fisura
```

1. **Forjar.** Se crea un job (`status = pending`) en `yunque.jobs`, con su `prompt`,
   `repo_path`, `model`, `max_turns` y herramientas permitidas. Se hace con la tool
   `enqueue_job` (job suelto) o, mejor, `forge_plan_item` / `approve_plan_item` (una
   partida del plan de un proyecto).
2. **El worker lo toma.** Reclama el siguiente job de forma atómica (uno por repo,
   hasta `YUNQUE_MAX_PARALLEL` a la vez), materializa el plan del proyecto en
   `<repo>/.yunque/PLAN.md`, inyecta la **doctrina** en el system-prompt y corre
   `claude -p` en el repo, streameando su razonamiento en vivo.
3. **El temple (auto-verificación, MP-12).** Antes de cerrar `done`, un `claude -p`
   **independiente** (`run_verification` en `worker/yunque_worker.py`) inspecciona el
   repo, lee los archivos tocados y corre el green gate. Su última línea debe ser
   EXACTAMENTE `VEREDICTO: PASS` o `VEREDICTO: FAIL`. Si es FAIL (o no concluye), el
   job cae a **fisura** en vez de cerrarse en falso (fail-closed). El temple es el
   caza-fantasmas: atrapa el trabajo que se reportó hecho pero no lo está.
4. **Evidencia.** Al cerrar, el resultado, costo, turnos, transcript y veredicto del
   temple quedan registrados (`jobs.verify_status`, `verify_verdict`, etc.) y se emite
   un evento estructurado a la bitácora (`yunque.events`). Un proyecto con plan además
   pasa por el **director** (re-dirige los MPs que faltan según el resultado real) y el
   **auditor de alcance** (compara lo PEDIDO en el brief contra lo ENTREGADO, criterio
   por criterio).

**Modos de operación:**
- **Supervisado.** Las partidas caen en una **bandeja de aprobación**
  (`awaiting_approval`) y esperan tu visto bueno antes de forjarse. Se revisan con
  `list_approvals` y se sueltan con `approve_plan_item` / `reject_plan_item`.
- **Autónomo.** Con el auto-piloto encendido (`set_project_autopilot on=true`), el
  cerebro construye el proyecto SOLO hasta terminar: genera el plan si falta, forja las
  partidas en orden, re-forja las fisuras (hasta un tope) y marca el proyecto completado.

---

## 3 · Herramientas del MCP y orden recomendado

El MCP registra las herramientas en cinco grupos (una función de registro por grupo en
`mcp/src`). **Orden recomendado al conectarte: primero `guia`, luego ponte al día
(`fleet_summary` → `list_events` → `list_projects`), y solo entonces actúa.**

**a) Cola, flota y planes** (`tools.ts`, `registerAllTools`):
- *Ponerte al día:* `fleet_summary` (conteo por estado + costo del día + fantasmas
  cazados) · `list_events` (bitácora estructurada del servicio) · `bitacora` (la vía de
  vuelta del director/auditor) · `alcance` (brief pedido vs. entregado).
- *Jobs:* `list_jobs` · `get_job` · `enqueue_job` · `cancel_job`.
- *Higiene de la flota:* `archive_job` · `restore_job` · `delete_job` ·
  `archive_jobs_by_status`.
- *Tareas:* `list_tasks` · `enqueue_task`.
- *Proyectos y plan vivo:* `create_project` · `list_projects` · `add_plan_items` ·
  `get_project_plan` · `set_plan_item_model` · `forge_plan_item` · `set_plan_item_done`.
- *Auto-piloto y bandeja:* `set_project_autopilot` · `list_approvals` ·
  `approve_plan_item` · `reject_plan_item` · `set_project_trust` (DEPRECADO, sin efecto).
- *Expediente del proyecto:* `add_project_entry` · `list_project_entries` ·
  `set_project_entry_pinned` · `delete_project_entry`.
- *Entregables:* `generate_project_report` · `list_project_documents` ·
  `delete_project_document`.
- *Lecciones aprendidas (memoria de la fragua):* `list_lecciones` (destilado accionable
  de cada cierre — «funcionó: …» / «se rompió: … → recordar: …») · `add_leccion` (dejar
  una a mano). Se capturan SOLAS al cerrar cada job; ver §6.

**b) Lectura de disco, solo lectura** (`fs-tools.ts`, `registerFsTools`):
`read_file` · `list_dir` · `stat_path` · `find_files` · `grep_files`. Para inspeccionar
el filesystem de la máquina del MCP sin escribir nada.

**c) Manejo de archivos, ESCRITURA** (`fs-manage-tools.ts`, `registerFsManageTools`):
`create_dir` · `write_file` · `copy_path` · `move_path` · `rename_path` · `delete_path`.
Organizar el disco como el Explorador de Windows, por comando. **Exigen que
`YUNQUE_FS_ROOTS` esté definida**: sin una raíz declarada no se escribe/mueve/borra nada.

**d) Documentos** (`doc-tools.ts`, `registerDocTools`):
`read_document` (extrae texto de PDF/Word/Excel/CSV) · `generate_document` (genera
PDF/Word/Excel/HTML listos para imprimir desde Markdown o filas).

**e) Impresión local de Windows** (`print-tools.ts`, `registerPrintTools`):
`list_printers` · `print_file` · `print_text`. Mandar a la impresora local por comando,
sin abrir programas (respeta `YUNQUE_FS_ROOTS` y `YUNQUE_PRINT_ENABLED`).

**f) Esta guía** (`guia-tools.ts`, `registerGuiaTool`): `guia` — devuelve este documento
completo.

---

## 4 · Procedimiento de codificación: FASE 0 (spec-driven)

**TODO job de código debe pasar por Fase 0 antes de codificar.** Fase 0 es la fase de
DISEÑO que le faltaba a Yunque (antes solo ejecutaba "Implement"). Sigue el flujo
spec-kit:

```
constitution → spec → plan → tasks → [GATE de diseño] → implement
```

- **constitution** — `.specify/constitution.md`, una vez por repo: las reglas duras de
  gobierno (ver sección 5). Ningún `spec/plan/tasks` puede contradecirla.
- **spec.md** — QUÉ y POR QUÉ, sin stack: problema, qué se quiere, y **criterios de
  aceptación verificables**.
- **plan.md** — arquitectura, stack, dónde vive cada cosa, restricciones, verificación.
- **tasks.md** — tareas chiquitas en orden de "un solo viaje", cada una con criterio
  **ATDD** (Dado / Cuando / Entonces): un test que FALLA antes y PASA después.
- **GATE de diseño** — antes de tocar código se confirma que la constitución se respeta
  (green gate, fail-closed, sin API key, sin secretos, licencias, ATDD). Solo si el gate
  PASA se procede a Implement.

Los artefactos viven en `<repo>/.specify/<slug>/{spec,plan,tasks}.md` y **se dejan
rastreados en git** (son el registro de diseño). El worker tiene una compuerta
(`fase0_gate`, env `YUNQUE_FASE0_GATE`: `off` por defecto / `warn` / `enforce`) que
puede exigir esos artefactos antes de forjar. Regla de oro (doctrina): **"Mide diez
veces, corta una sola vez"** — un solo viaje de codificación completo, no fragmentado;
commits atómicos, un PR.

---

## 5 · Reglas duras (y el anti-verde-falso)

Estas reglas gobiernan TODO trabajo de la fragua. No se negocian:

1. **Suscripción, NUNCA API key.** `claude` autentica con la suscripción del CLI de
   Cesar. `ANTHROPIC_API_KEY` queda vacía a propósito. (Excepción única: el disparador,
   con token y presupuesto propios, apagado por defecto.)
2. **Nunca comitear `.env`.** Los secretos viven solo en el `.env` de la raíz
   (git-ignorado). Se versiona `.env.example`, nunca el `.env` real.
3. **Licencias MIT/Apache-2.0 solamente.** Nada de dependencias con licencias
   restrictivas.
4. **La verdad vive en la base** (Postgres/Supabase, schema `yunque`). No se toca por la
   API REST. Las migraciones se aplican con `apply_migration` y se registran en `db/*.sql`.
5. **No borrar triggers ni tareas programadas.** Dos triggers llenan el plan y el
   expediente solos; el runner corre como tarea de inicio. Romperlos desarma el servicio.
6. **Green gate.** No terminas hasta que build + tests + CI están verdes. Si algo queda
   rojo, no lo tapes: para y repórtalo.
7. **Fail-closed.** Cuando no puedes DEMOSTRAR que algo quedó hecho/verificado, la
   decisión por defecto es la segura (no cerrar `done`), no la conveniente.

**Anti-verde-falso (el corazón del temple):** *nunca confíes en un "verify: pass" sin
evidencia dura.* Un reporte que dice "listo, todo verde" no es evidencia; la evidencia es
**junit** de una suite que corrió, **rutas** de archivos que existen en disco, **hashes de
commit** reales, salida de build sin errores. El temple es un inspector independiente
precisamente porque el propio agente que hizo el trabajo no es un juez fiable de si lo
hizo. Si no hay evidencia dura, es fisura, no `done`.

---

## 6 · Lecciones aprendidas

Yunque **aprende de cada job**. La memoria vive en la tabla `yunque.lecciones` y se llena
**sola**: al cerrar CUALQUIER job, el worker inserta UNA lección derivada
determinísticamente de lo que ya tiene (veredicto del temple, gate de entregables, causa
del bloqueo) — **sin gastar un LLM extra**, y **best-effort** (un fallo guardando la
lección jamás tumba el cierre del job). Se captura en TODOS los caminos de cierre:

- **Éxito** (temple `pass`/`audited`/`fail-open`/verificación desactivada, el job cierra
  `done`): `categoria='exito'`, lección «funcionó: temple=… gate=… · <resumen>».
- **Fisura/bloqueo** (entregable declarado inexistente, temple no concluyente escalado,
  veredicto `fail`): `categoria='fisura'`, con la **causa real** y lección «se rompió: …
  → recordar: verificar esto antes de cerrar y exigir evidencia dura».

**Cómo leerlas y escribirlas:**
- **`list_lecciones`** (`project_id?`, `categoria?`, `limite=20`): las lecciones recientes,
  más nuevas primero. Con `project_id` devuelve las de ESE proyecto **más** las globales
  (las de `project_id` nulo). Llámala **antes de forjar** para no repetir errores.
- **`add_leccion`** (`titulo`, `leccion`, `categoria`, `project_id?`, `causa?`): deja una
  lección a mano (para un coworker o Cesar). Sin `project_id`, la lección es **GLOBAL**.
- **PWA:** el bloque **«Lecciones recientes»** (vista Flota) las muestra en el celular,
  solo lectura, leyendo del endpoint REST `GET /api/lecciones`.

Las decisiones históricas de arquitectura siguen en
[`docs/09-HISTORIA-Y-DECISIONES.md`](09-HISTORIA-Y-DECISIONES.md) y el expediente
[`docs/`](EXPEDIENTE.md); las **lecciones operativas** (qué funcionó / qué se rompió) ahora
son datos vivos en `yunque.lecciones`.

---

## 7 · El MCP de Railway (el de claude.ai)

**Hay DOS servidores MCP de Yunque, no uno.** Son repos y despliegues distintos, y hoy
NO están al día entre sí:

| | MCP local (este repo) | MCP de Railway |
|---|---|---|
| Quién lo usa | Celular de Cesar (PWA, vía túnel cloudflared) | Coworkers en **claude.ai** (la web) |
| Dónde vive el código | `mcp/` dentro de `05YUNQUE` | Repo aparte, ver ruta abajo |
| Cómo corre | En la PC de Cesar (proceso local, puerto 47700) | En Railway (nube, se redespliega solo) |
| Tiene el briefing (`instructions` + tool `guia`) | **Sí** — esta misma guía | **No** (todavía) |
| Tiene lecciones aprendidas (`list_lecciones`/`add_leccion`) | **Sí** | **No** (todavía) |
| Tiene el LAZO (`lanzar_lazo` · `lazo_estado` · `lazo_alto`) | No (todavía) | **Sí** (LAZO-4): soltar un plan acordado en el chat, ver cómo va, y frenarlo cuando Cesar dice «ALTO» |

### Dónde está el clon del MCP de Railway en esta PC

```
C:\Users\Usuario1\01DESARROLLO\_scratch\yunque-mcp
```

Confirmado leyendo ese repo (no es un dato inventado):

- **Remote de GitHub:** `https://github.com/CRFong81/yunque-mcp.git`
- **Rama por defecto:** `main`
- Railway está conectado a ese repo/rama de GitHub y **redespliega solo** con cada push
  a `main` — no hay un paso manual de "subir a Railway".
- El servidor es `src/server.js` (Node/Express, sin TypeScript). Hoy registra tools con
  nombres en español (`estado`, `proyectos`, `mps`, `jobs`, `forjar`, `cancelar_job`,
  `tareas`, `crear_tarea`, `completar_tarea`, `eventos`, `bitacora`, `alcance`) pero **no
  tiene** el campo `instructions` en la respuesta de `initialize`, ni la tool `guia`, ni
  las tools de lecciones (`list_lecciones`/`add_leccion`) que sí tiene el MCP local.

### Cómo se actualiza para que quede igual al local

1. Abrir el clon: `C:\Users\Usuario1\01DESARROLLO\_scratch\yunque-mcp`.
2. Portar a `src/server.js` (o donde corresponda) lo que hoy solo vive en `mcp/` de este
   repo:
   - El mismo `instructions` (el briefing denso que se inyecta al conectar).
   - La tool `guia` (equivalente a `mcp/src/guia-tools.ts`) — puede leer este mismo
     `docs/GUIA-YUNQUE.md` si el repo de Railway tiene acceso a él, o llevar una copia
     del texto.
   - Las tools de lecciones (`list_lecciones` / `add_leccion`), equivalentes a las que
     ya existen en `mcp/src/tools.ts`.
3. Probar localmente (`npm start` en ese repo) antes de subir.
4. `git add` + `git commit` + **`git push origin main`** en ese repo. Railway detecta el
   push y redespliega solo — no hace falta tocar nada en el panel de Railway.

**Advertencia (el único paso que necesita a Cesar):** el `push` requiere que la PC tenga
la sesión de GitHub autenticada como Cesar (`CRFong81`). Si el login de git/GitHub no
está activo en esa PC, el push falla y hay que pedirle a Cesar que inicie sesión (o lo
haga él mismo) antes de continuar.

**Nota:** esta sección que estás leyendo ya cuenta como parte del manual — la tool
`guia` del MCP **local** la lee en runtime directamente de este archivo
(`docs/GUIA-YUNQUE.md`), así que el cambio se ve apenas se guarda, sin recompilar nada.
Eso NO aplica todavía al MCP de Railway hasta que se porte el paso 2 de arriba.
