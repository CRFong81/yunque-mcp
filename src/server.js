// ============================================================
// YUNQUE MCP SERVER
// Control del orquestador de Cesar desde cualquier chat/celular.
// Habla con Supabase (schema yunque) via REST — sin WebSocket.
// ============================================================
import express from "express";

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MCP_SECRET = process.env.MCP_SECRET || "";

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  "Accept-Profile": "yunque",
  "Content-Profile": "yunque",
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
  return await rpc("yq_cancelar", { p_job_id: job_id });
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
    p_titulo: titulo,
    p_categoria: categoria,
    p_notas: notas,
    p_prioridad: prioridad,
    p_vence: vence,
    p_hoy: hoy,
  });
}

async function completarTarea({ id }) {
  return await rpc("yq_completar_tarea", { p_id: id });
}

async function eventos({ limite = 20, solo_alertas = false }) {
  const r = await rpc("yq_eventos", { p_limite: limite, p_solo_alertas: solo_alertas });
  return { total: r.length, eventos: r };
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
];

// ---------------- transporte ----------------
const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/", (_req, res) =>
  res.json({ name: "yunque-mcp", status: "ok", tools: TOOLS.map((t) => t.name) })
);
app.get("/health", (_req, res) => res.json({ ok: true }));

const auth = (req) =>
  !MCP_SECRET || (req.headers.authorization || "") === `Bearer ${MCP_SECRET}`;

app.post("/mcp", async (req, res) => {
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
      return ok({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    }
    return fail(`Metodo no soportado: ${method}`, -32601);
  } catch (err) {
    console.error("[mcp]", err);
    return fail(err.message || String(err));
  }
});

app.listen(PORT, () => {
  console.log(`YUNQUE MCP escuchando en :${PORT}`);
  console.log(`Herramientas: ${TOOLS.map((t) => t.name).join(", ")}`);
});
