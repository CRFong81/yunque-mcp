// ============================================================
// TARJETAS — leer y decidir las tarjetas de Cesar desde el chat (Y7-MCP-RAILWAY-TARJETAS).
// Lectura: tarjetas, rendimiento, planta, alertas_cabina (RPC public.yq_*, sin p_token).
// Escritura: decidir_tarjeta, comentar_tarjeta (p_token; el canal es FIJO «claude-chat» en la base:
// NO es un argumento). La verdad y las reglas fuertes (gana la primera, puerta 8, «no» con razón)
// viven en la base; aquí solo se rechaza lo obviamente mal formado antes de gastar un viaje de red.
// Mientras settings.tarjetas_remotas esté apagada, la base responde «canal claude-chat remoto apagado».
// ============================================================

const DECISIONES = ["si", "no", "tal_vez", "visto"];
const FILTROS = ["Decisiones", "Atención", "Visto"];

export const DESCRIPCION_DECIDIR =
  "Solo con una respuesta explícita de Cesar en esta conversación. Repítele la decisión antes de llamar. " +
  "La puerta 8 pide confirmado=true en una segunda llamada.";

const texto = (v) => (typeof v === "string" ? v.trim() : "");

export function tarjetasTools(rpc, secret) {
  async function tarjetas({ filtro = null } = {}) {
    const f = texto(filtro);
    if (f && !FILTROS.some((x) => x.toLowerCase() === f.toLowerCase()) && !["todas", "todo"].includes(f.toLowerCase()))
      throw new Error("filtro inválido: Decisiones, Atención o Visto (o nada para todas)");
    return await rpc("yq_tarjetas", { p_filtro: f || null });
  }

  async function rendimiento({ lang = "es" } = {}) {
    const metricas = await rpc("yq_rendimiento", { p_lang: texto(lang) || "es" });
    return { metricas };
  }

  async function planta() {
    return { proyectos: await rpc("yq_planta") };
  }

  async function alertasCabina({ lang = "es", limite = 50 } = {}) {
    const n = Number.isInteger(limite) && limite > 0 ? Math.min(limite, 500) : 50;
    return await rpc("yq_alertas_cabina", { p_lang: texto(lang) || "es", p_limite: n });
  }

  async function decidirTarjeta({ id, decision, razon = null, confirmado = false }) {
    if (!texto(id)) throw new Error("Falta id de la tarjeta");
    const d = texto(decision).toLowerCase().replace(/[\s-]+/g, "_");
    if (!DECISIONES.includes(d)) throw new Error("decision debe ser si | no | tal_vez | visto");
    const r = texto(razon);
    if (d === "no" && !r) throw new Error("«no» exige la razón: sin razón no se envía (la tarjeta sigue igual)");
    return await rpc("yq_decidir_tarjeta", {
      p_token: secret,
      p_id: texto(id),
      p_decision: d,
      p_razon: r || null,
      p_confirmado: confirmado === true,
    });
  }

  async function comentarTarjeta({ id, texto: t }) {
    if (!texto(id)) throw new Error("Falta id de la tarjeta");
    if (!texto(t)) throw new Error("El comentario está vacío");
    return await rpc("yq_comentar_tarjeta", { p_token: secret, p_id: texto(id), p_texto: texto(t).slice(0, 4000) });
  }

  return [
    {
      name: "tarjetas",
      lectura: true,
      description:
        "Lista las TARJETAS abiertas de Cesar (decisiones, atención, visto) con su evidencia (título, cuerpo, " +
        "proyecto, partida, puerta, si pide doble confirmación, comentarios). Es la misma verdad que ven el " +
        "celular y la PC. Léelas antes de proponerle algo a Cesar.",
      inputSchema: {
        type: "object",
        properties: {
          filtro: { type: "string", enum: FILTROS, description: "Decisiones | Atención | Visto. Omitir = todas." },
        },
      },
      handler: tarjetas,
    },
    {
      name: "rendimiento",
      lectura: true,
      description:
        "Las 9 métricas de Rendimiento de la semana (valor, semana anterior, n, meta, estado) con su definición y " +
        "la consulta que las calcula. Sin dato = null/'sin_datos', nunca 0.",
      inputSchema: { type: "object", properties: { lang: { type: "string", enum: ["es", "en"], description: "Idioma. Default es." } } },
      handler: rendimiento,
    },
    {
      name: "planta",
      lectura: true,
      description: "La PLANTA: por proyecto, su estación actual, trabajos en curso y si espera una tarjeta de Cesar.",
      inputSchema: { type: "object", properties: {} },
      handler: planta,
    },
    {
      name: "alertas_cabina",
      lectura: true,
      description: "Alertas vivas de la cabina (eventos que piden atención y no están cerrados), con título y qué hizo Yunque después.",
      inputSchema: {
        type: "object",
        properties: {
          lang: { type: "string", enum: ["es", "en"], description: "Idioma. Default es." },
          limite: { type: "number", description: "Máximo de alertas (default 50, tope 500)." },
        },
      },
      handler: alertasCabina,
    },
    {
      name: "decidir_tarjeta",
      description: DESCRIPCION_DECIDIR,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "UUID de la tarjeta (de la tool tarjetas)." },
          decision: { type: "string", enum: DECISIONES, description: "si | no | tal_vez | visto." },
          razon: { type: "string", description: "Obligatoria con «no»: vuelve a la estación con esa nota." },
          confirmado: { type: "boolean", description: "true en la SEGUNDA llamada de la puerta 8 / paso irreversible." },
        },
        required: ["id", "decision"],
      },
      handler: decidirTarjeta,
    },
    {
      name: "comentar_tarjeta",
      description:
        "Deja un comentario de Cesar en una tarjeta (un @agente existente lo vuelve tarea de ese agente). " +
        "Solo con texto dictado por Cesar en esta conversación.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "UUID de la tarjeta." },
          texto: { type: "string", description: "El comentario." },
        },
        required: ["id", "texto"],
      },
      handler: comentarTarjeta,
    },
  ];
}
