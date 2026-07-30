// ============================================================
// YUNQUE MCP SERVER
// Control del orquestador de Cesar desde cualquier chat/celular.
// Habla con Supabase (schema yunque) via REST — sin WebSocket.
// ============================================================
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MCP_SECRET = process.env.MCP_SECRET || "";

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

async function rpc(fn, args = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: SB_HEADERS,
    body: JSON.stringify(args),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${txt}`);
  return txt ? JSON.parse(txt) : null;
}

// ---------------- briefing de arranque ----------------
// Lo PRIMERO que ve un coworker de claude.ai al conectarse. Debe bastar para operar
// Yunque bien sin preguntar. El detalle completo lo devuelve la tool `guia`.
const INSTRUCTIONS =
  "YUNQUE — fábrica de software autónoma (una 'fragua'). Convierte tareas en JOBS ejecutados " +
  "por Claude Code headless (`claude -p`) sobre repos reales, en la PC de Cesar. Claude corre " +
  "por la SUSCRIPCIÓN del CLI, NUNCA por API key. Una sola fuente de verdad: Postgres/Supabase, " +
  "schema `yunque`; los procesos se coordinan escribiendo/leyendo la base. Componentes: worker " +
  "(ejecuta jobs), auto-piloto (planea y forja solo), este MCP server (la cola como " +
  "herramientas), desktop Electron y una PWA móvil.\n\n" +
  "EL CICLO: forjar (encolar un job) → el worker corre Claude Code en el repo → el TEMPLE (un " +
  "`claude -p` INDEPENDIENTE inspecciona el repo y corre el green gate) verifica antes de cerrar " +
  "'done' → se emite EVIDENCIA estructurada al cerrar. Si el temple no puede DEMOSTRAR que quedó " +
  "hecho, el job cae a FISURA en vez de cerrarse en falso (fail-closed). Dos modos: SUPERVISADO " +
  "(las partidas esperan aprobación) y AUTÓNOMO (con el auto-piloto encendido, el cerebro " +
  "construye el proyecto solo hasta terminar).\n\n" +
  "HERRAMIENTAS (orden recomendado: primero llama `guia`, luego ponte al día con estado → " +
  "eventos → proyectos, y recién entonces actúa). Memoria de LECCIONES (yunque acumula lo " +
  "aprendido con cada cierre de job, se captura SOLA, sin gastar un LLM): list_lecciones (léelas " +
  "ANTES de forjar para no repetir errores y reusar lo que funcionó), add_leccion (deja una a " +
  "mano). Cola/flota/planes: estado, eventos, bitacora, alcance (ponerse al día); jobs, forjar, " +
  "cancelar_job; mps, proyectos; tareas, crear_tarea, completar_tarea.\n\n" +
  "PROCEDIMIENTO DE CODIFICACIÓN — FASE 0 (spec-driven): TODO job de código pasa por constitution " +
  "→ spec → plan → tasks → [GATE de diseño] → implement, con los artefactos en " +
  "`<repo>/.specify/<slug>/`. Doctrina: 'mide diez veces, corta una sola vez' — un solo viaje de " +
  "codificación completo, commits atómicos, un PR. El `prompt` de forjar debe ser COMPLETO y " +
  "autocontenido (el worker no ve esta conversación).\n\n" +
  "REGLAS DURAS: suscripción, NUNCA API key; nunca comitear `.env`; licencias MIT/Apache-2.0; la " +
  "verdad vive en la base; no borrar triggers ni tareas programadas; green gate (no terminas " +
  "hasta build+tests+CI verdes; si algo queda rojo, para y repórtalo); fail-closed. " +
  "ANTI-VERDE-FALSO: nunca confíes en un 'verify: pass' sin EVIDENCIA DURA — junit de una suite " +
  "que corrió, rutas de archivos que existen, hashes de commit reales, salida de build sin " +
  "errores. Un reporte que dice 'todo verde' no es evidencia.\n\n" +
  "Para el detalle completo llama a la herramienta `guia`.";

// ---------------- herramientas ----------------

async function estado() {
  const e = await rpc("yq_estado");
  const r = e.runner || {};
  return {
    ...e,
    resumen: r.vivo
      ? `Yunque VIVO (latido hace ${r.ultimo_latido_hace_seg}s). ${e.cola.ejecutando} ejecutando, ${e.cola.pendientes} en cola.`
      : `⚠ Yunque CAIDO — el runner no late hace ${r.ultimo_latido_hace_seg || "?"}s. La cola esta detenida.`,
  };
}

async function proyectos() {
  const p = await rpc("yq_proyectos");
  return {
    total: p.length,
    proyectos: p.map((x) => ({
      nombre: x.nombre,
      estado: x.estado,
      autopilot: x.autopilot,
      avance: `${x.mps_hechos}/${x.mps_total}`,
      jobs_activos: Number(x.jobs_activos || 0),
      trabajando_en: x.trabajando_en || null,
      repo: x.repo,
    })),
  };
}

async function mps({ proyecto = null, solo_abiertos = false }) {
  const r = await rpc("yq_mps", { p_proyecto: proyecto, p_solo_abiertos: solo_abiertos });
  return { total: r.length, mps: r };
}

async function jobs({ status = null, limite = 15 }) {
  const r = await rpc("yq_jobs", { p_status: status, p_limite: limite });
  return { total: r.length, jobs: r };
}

async function forjar({
  titulo,
  prompt,
  proyecto = null,
  model = "sonnet",
  max_turns = 40,
  allowed_tools = "Read,Write,Edit,Bash",
  prioridad = 100,
}) {
  return await rpc("yq_forjar", {
    p_token: MCP_SECRET,
    p_titulo: titulo,
    p_prompt: prompt,
    p_proyecto: proyecto,
    p_model: model,
    p_max_turns: max_turns,
    p_allowed_tools: allowed_tools,
    p_prioridad: prioridad,
  });
}

async function cancelar({ job_id }) {
  return await rpc("yq_cancelar", { p_token: MCP_SECRET, p_job_id: job_id });
}

async function tareas({ status = "todo" }) {
  const r = await rpc("yq_tareas", { p_status: status });
  return { total: r.length, tareas: r };
}

async function crearTarea({
  titulo,
  categoria = null,
  notas = null,
  prioridad = "medium",
  vence = null,
  hoy = false,
}) {
  return await rpc("yq_crear_tarea", {
    p_token: MCP_SECRET,
    p_titulo: titulo,
    p_categoria: categoria,
    p_notas: notas,
    p_prioridad: prioridad,
    p_vence: vence,
    p_hoy: hoy,
  });
}

async function completarTarea({ id }) {
  return await rpc("yq_completar_tarea", { p_token: MCP_SECRET, p_id: id });
}

async function eventos({ limite = 20, solo_alertas = false }) {
  const r = await rpc("yq_eventos", { p_limite: limite, p_solo_alertas: solo_alertas });
  return { total: r.length, eventos: r };
}

async function bitacora({ proyecto = null, tipo = null, since = null, limite = 50 }) {
  return await rpc("yq_bitacora", {
    p_proyecto: proyecto,
    p_tipo: tipo,
    p_since: since,
    p_limite: limite,
  });
}

async function alcance({ proyecto }) {
  return await rpc("yq_alcance", { p_proyecto: proyecto });
}

// --- MEMORIA DE LECCIONES (yunque.lecciones, compartida con el MCP local) ---
async function listLecciones({ project_id = null, categoria = null, limite = 20 }) {
  const r = await rpc("yq_lecciones", {
    p_project_id: project_id,
    p_categoria: categoria,
    p_limite: limite,
  });
  const lecciones = Array.isArray(r) ? r : [];
  return { total: lecciones.length, lecciones };
}

async function addLeccion({ titulo, leccion, categoria = "proceso", project_id = null, causa = null }) {
  return await rpc("yq_add_leccion", {
    p_token: MCP_SECRET,
    p_titulo: titulo,
    p_leccion: leccion,
    p_categoria: categoria,
    p_project_id: project_id,
    p_causa: causa,
  });
}

// --- GUIA: briefing completo, leido de disco en runtime (src/GUIA.md) ---
const GUIA_FALLBACK =
  "GUÍA DE YUNQUE (respaldo — no se encontró src/GUIA.md en disco).\n\n" +
  "Yunque es una fábrica de software autónoma: corre Claude Code headless (`claude -p`, " +
  "por la SUSCRIPCIÓN de Cesar, NUNCA API key) sobre repos reales; el estado vive en " +
  "Supabase (schema `yunque`). Ciclo: forjar (encolar job) → el worker corre Claude en el " +
  "repo → el TEMPLE (inspector independiente) verifica → se emite EVIDENCIA al cerrar. " +
  "Modos Supervisado y Autónomo. Todo job de código pasa por FASE 0 " +
  "(constitution→spec→plan→tasks→gate→implement). Reglas duras: suscripción no API key; " +
  "nunca comitear `.env`; licencias MIT/Apache-2.0; no borrar triggers/tareas; green gate " +
  "+ fail-closed; ANTI-VERDE-FALSO: nunca confíes en un 'verify: pass' sin evidencia dura.";

function readGuia() {
  const candidates = [
    path.join(__dirname, "GUIA.md"),
    path.resolve(__dirname, "..", "GUIA.md"),
    path.resolve(process.cwd(), "src", "GUIA.md"),
    path.resolve(process.cwd(), "GUIA.md"),
  ];
  for (const c of candidates) {
    try {
      const t = fs.readFileSync(c, "utf8");
      if (t.trim().length > 0) return t;
    } catch {
      /* no existe / sin permiso: probar el siguiente candidato */
    }
  }
  return GUIA_FALLBACK;
}

// Devuelve el texto crudo (el transporte lo emite tal cual, sin envolver en JSON).
async function guia() {
  return readGuia();
}

// ---------------- registro MCP ----------------
const TOOLS = [
  {
    name: "estado",
    description:
      "Estado de Yunque de un vistazo: si el runner esta vivo, cuantos jobs se estan ejecutando, la cola, las alertas abiertas y los MPs pendientes. Usar cuando Cesar pregunta '¿como esta Yunque?' o '¿esta trabajando?'.",
    inputSchema: { type: "object", properties: {} },
    handler: estado,
  },
  {
    name: "proyectos",
    description: "Lista los proyectos de Yunque (QUANTIX, ORYM, CafeCAD, Prevolo, Yunque) con su avance de MPs y si el autopiloto esta encendido.",
    inputSchema: { type: "object", properties: {} },
    handler: proyectos,
  },
  {
    name: "mps",
    description:
      "Lista las partidas (MPs) del plan de un proyecto: cuales estan cerradas, cuales abiertas, y el estado de su job. Usar para saber que falta de un proyecto.",
    inputSchema: {
      type: "object",
      properties: {
        proyecto: { type: "string", description: "Nombre del proyecto, ej. QUANTIX. Omitir para ver todos." },
        solo_abiertos: { type: "boolean", description: "true = solo los MPs sin cerrar" },
      },
    },
    handler: mps,
  },
  {
    name: "jobs",
    description: "Lista los jobs recientes de Yunque con su estado, costo y veredicto de verificacion.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "pending | running | done | error | cancelled" },
        limite: { type: "number" },
      },
    },
    handler: jobs,
  },
  {
    name: "forjar",
    description:
      "ENCOLA UN TRABAJO NUEVO para que Yunque lo ejecute con Claude Code en la PC de Cesar. Este es el corazon: convierte una instruccion en lenguaje natural en trabajo real de software. El prompt debe ser completo y autocontenido (el worker no ve esta conversacion). Requiere que el runner este vivo.",
    inputSchema: {
      type: "object",
      properties: {
        titulo: { type: "string", description: "Titulo corto del trabajo" },
        prompt: { type: "string", description: "La instruccion completa para Claude Code. Autocontenida, con contexto y criterios de exito." },
        proyecto: { type: "string", description: "Proyecto (define el repo donde se ejecuta): QUANTIX, ORYM, CafeCAD, Prevolo, Yunque" },
        model: { type: "string", description: "sonnet (default) u opus para trabajo complejo" },
        max_turns: { type: "number", description: "Limite de turnos, default 40" },
        allowed_tools: { type: "string", description: "Default: Read,Write,Edit,Bash" },
      },
      required: ["titulo", "prompt"],
    },
    handler: forjar,
  },
  {
    name: "cancelar_job",
    description: "Cancela un job que esta pendiente o corriendo.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
    handler: cancelar,
  },
  {
    name: "tareas",
    description: "Lista las tareas pendientes de Cesar (su lista de pendientes personal en Yunque).",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", description: "todo (default) | in_progress | done" } },
    },
    handler: tareas,
  },
  {
    name: "crear_tarea",
    description: "Crea una tarea nueva en la lista de pendientes de Cesar.",
    inputSchema: {
      type: "object",
      properties: {
        titulo: { type: "string" },
        categoria: { type: "string" },
        notas: { type: "string" },
        prioridad: { type: "string", description: "high | medium | low" },
        vence: { type: "string", description: "YYYY-MM-DD" },
        hoy: { type: "boolean", description: "marcar como prioridad de hoy" },
      },
      required: ["titulo"],
    },
    handler: crearTarea,
  },
  {
    name: "completar_tarea",
    description: "Marca una tarea como completada.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    handler: completarTarea,
  },
  {
    name: "eventos",
    description: "Bitacora de Yunque: que ha pasado (jobs forjados, fisuras, alertas del runner). Usar solo_alertas=true para ver lo que necesita atencion.",
    inputSchema: {
      type: "object",
      properties: {
        limite: { type: "number" },
        solo_alertas: { type: "boolean" },
      },
    },
    handler: eventos,
  },
  {
    name: "bitacora",
    description:
      "Lee la BITACORA del director y el auditor de alcance (MP-DIRECTOR): la via de vuelta que deja lista para retomar el hilo en una sola consulta. Cada entrada trae tipo (hallazgo=lo que un job revelo y contradijo el plan, desvio=el plan se aparto del brief, pregunta=decision de producto para Cesar, cierre=veredicto del auditor de alcance), un resumen legible, el detalle y datos estructurados. Mas recientes primero.",
    inputSchema: {
      type: "object",
      properties: {
        proyecto: { type: "string", description: "Nombre del proyecto (ej. 'Yunque', 'ORYM') o su UUID. Omitir para ver todos." },
        tipo: { type: "string", description: "hallazgo | desvio | pregunta | cierre" },
        since: { type: "string", description: "ISO 8601 — solo entradas posteriores (consumo incremental)." },
        limite: { type: "number", description: "Maximo de entradas (default 50)." },
      },
    },
    handler: bitacora,
  },
  {
    name: "alcance",
    description:
      "Muestra el ALCANCE de un proyecto (MP-DIRECTOR): el BRIEF ORIGINAL de Cesar y sus criterios de aceptacion (lo PEDIDO), junto al ultimo veredicto del AUDITOR DE ALCANCE criterio por criterio (CUMPLE / NO_CUMPLE / NO_VERIFICABLE con su evidencia, lo ENTREGADO). Un proyecto solo esta de verdad terminado si el auditor confirma todos los criterios.",
    inputSchema: {
      type: "object",
      properties: {
        proyecto: { type: "string", description: "Proyecto a auditar: su nombre (ej. 'Yunque', 'ORYM') o su UUID." },
      },
      required: ["proyecto"],
    },
    handler: alcance,
  },
  {
    name: "guia",
    description:
      "Briefing completo de Yunque para cualquier coworker: qué es, cómo funciona el ciclo " +
      "(forjar→worker→temple→evidencia), las herramientas y su orden, el procedimiento de " +
      "codificación Fase 0, las reglas duras y el anti-verde-falso, y la memoria de lecciones. " +
      "Llámala apenas te conectes, antes de actuar.",
    inputSchema: { type: "object", properties: {} },
    handler: guia,
  },
  {
    name: "list_lecciones",
    description:
      "Lee la MEMORIA de LECCIONES de Yunque (yunque.lecciones): el destilado accionable de cada " +
      "cierre de job ('funcionó: …' / 'se rompió: … → recordar: …'), más nuevas primero. Con " +
      "project_id devuelve las de ESE proyecto MÁS las globales. Léela ANTES de forjar para no " +
      "repetir errores y reusar lo que funcionó.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "UUID del proyecto: sus lecciones + las globales. Omitir = todas las recientes." },
        categoria: { type: "string", description: "exito | fisura | proceso" },
        limite: { type: "number", description: "Máximo de lecciones (default 20)." },
      },
    },
    handler: listLecciones,
  },
  {
    name: "add_leccion",
    description:
      "Deja una LECCIÓN aprendida a mano en la memoria de la fragua (yunque.lecciones), para que " +
      "cualquier coworker o Cesar la lea al instante. Sin project_id, la lección es GLOBAL.",
    inputSchema: {
      type: "object",
      properties: {
        titulo: { type: "string", description: "Título breve de la lección." },
        leccion: { type: "string", description: "El aprendizaje accionable ('funcionó: …' / 'se rompió: … → recordar: …')." },
        categoria: { type: "string", description: "exito (algo que funcionó) | fisura (algo que se rompió) | proceso (cómo trabajar mejor). Default: proceso." },
        project_id: { type: "string", description: "UUID del proyecto al que pertenece. Omitir = GLOBAL." },
        causa: { type: "string", description: "Causa real (útil sobre todo en las de categoría 'fisura')." },
      },
      required: ["titulo", "leccion"],
    },
    handler: addLeccion,
  },
];

// ---------------- transporte ----------------
const app = express();
app.set("strict routing", true); // distingue /cabina/x de /cabina/x/ (necesario para el scope del SW)
app.use(express.json({ limit: "5mb" }));

app.get("/", (_req, res) =>
  res.json({ name: "yunque-mcp", status: "ok", tools: TOOLS.map((t) => t.name) })
);
app.get("/health", (_req, res) => res.json({ ok: true }));

const auth = (req) =>
  !MCP_SECRET || (req.headers.authorization || "") === `Bearer ${MCP_SECRET}`;

async function handleMcp(req, res) {
  if (!auth(req)) {
    return res.status(401).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: { code: -32001, message: "No autorizado" },
    });
  }
  const { id = null, method, params = {} } = req.body || {};
  const ok = (result) => res.json({ jsonrpc: "2.0", id, result });
  const fail = (message, code = -32603) =>
    res.json({ jsonrpc: "2.0", id, error: { code, message } });

  try {
    if (method === "initialize")
      return ok({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "yunque-mcp", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    if (method === "notifications/initialized") return res.status(204).end();
    if (method === "tools/list")
      return ok({
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    if (method === "tools/call") {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(`Herramienta desconocida: ${params.name}`, -32602);
      const result = await tool.handler(params.arguments || {});
      // Un handler que devuelve string (p.ej. `guia`) se emite tal cual; el resto como JSON.
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return ok({ content: [{ type: "text", text }] });
    }
    return fail(`Metodo no soportado: ${method}`, -32601);
  } catch (err) {
    console.error("[mcp]", err);
    return fail(err.message || String(err));
  }
}

// Ruta con cabecera Authorization: Bearer <secreto>
// --- CABINA: PWA instalable ---
const CABINA = fs.readFileSync(path.join(__dirname, "cabina.html"), "utf8");

const okSecret = (req) => !MCP_SECRET || req.params.secret === MCP_SECRET;

// sin barra final -> redirige (necesario para que el scope del SW cubra la app)
app.get("/cabina/:secret", (req, res) => {
  if (!okSecret(req)) return res.status(401).send("No autorizado");
  res.redirect(302, `/cabina/${req.params.secret}/`);
});

app.get("/cabina/:secret/", (req, res) => {
  if (!okSecret(req)) return res.status(401).send("No autorizado");
  res.type("html").send(CABINA);
});

// Manifiesto: lo que convierte la pagina en app instalable
app.get("/cabina/:secret/manifest.webmanifest", (req, res) => {
  if (!okSecret(req)) return res.status(401).end();
  res.type("application/manifest+json").json({
    name: "Yunque",
    short_name: "Yunque",
    description: "La fragua de Cesar — control de Yunque",
    start_url: "./",
    scope: "./",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b0d12",
    theme_color: "#0b0d12",
    icons: [
      { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  });
});

// Service worker: cachea el caparazon para que abra al instante
app.get("/cabina/:secret/sw.js", (req, res) => {
  if (!okSecret(req)) return res.status(401).end();
  res.type("application/javascript").send(`
const CACHE = "yunque-v1";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./"])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) =>
    Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // los datos SIEMPRE frescos de la red; nunca cacheados
  if (e.request.method !== "GET" || url.pathname.endsWith("/api")) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match("./")))
  );
});
`);
});

app.get("/cabina/:secret/icons/:file", (req, res) => {
  if (!okSecret(req)) return res.status(401).end();
  const f = path.basename(req.params.file);
  const p = path.join(__dirname, "icons", f);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.type("png").sendFile(p);
});

// API de la cabina
const cabinaApi = async (req, res) => {
  if (!okSecret(req)) return res.status(401).json({ error: "No autorizado" });
  const tool = TOOLS.find((t) => t.name === req.body?.tool);
  if (!tool) return res.status(404).json({ error: "Herramienta desconocida" });
  try {
    res.json(await tool.handler(req.body.args || {}));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
app.post("/cabina/:secret/api", cabinaApi);
app.post("/cabina-api/:secret", cabinaApi); // compatibilidad

app.post("/mcp", handleMcp);

// Ruta con el secreto en el path — para clientes que solo aceptan una URL
app.post("/mcp/:secret", (req, res) => {
  if (MCP_SECRET && req.params.secret !== MCP_SECRET) {
    return res.status(401).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: { code: -32001, message: "No autorizado" },
    });
  }
  req.headers.authorization = `Bearer ${MCP_SECRET}`;
  return handleMcp(req, res);
});

app.listen(PORT, () => {
  console.log(`YUNQUE MCP escuchando en :${PORT}`);
  console.log(`Herramientas: ${TOOLS.map((t) => t.name).join(", ")}`);
});
