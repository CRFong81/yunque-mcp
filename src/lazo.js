// ============================================================
// LAZO — soltar un plan desde el chat y dejarlo correr con frenos (LAZO-4).
// Tres tools sobre las RPC public.yq_lanzar_lazo / yq_lazo_estado / yq_lazo_alto
// (db/2026-10-14_lazo4_rpc.sql). La verdad y la validación fuerte viven en la base;
// aquí solo se rechaza lo obviamente mal formado antes de gastar un viaje de red.
// ============================================================

const MODELOS = ["haiku", "sonnet", "opus"];

function normalizarItems(items) {
  if (!Array.isArray(items) || items.length === 0)
    throw new Error("items debe ser una lista con al menos un paso");
  return items.map((it, i) => {
    const n = i + 1;
    if (!it || typeof it !== "object" || typeof it.title !== "string" || !it.title.trim())
      throw new Error(`Cada paso necesita title (paso ${n})`);
    const model = it.model == null || it.model === "" ? null : String(it.model).trim().toLowerCase();
    if (model && !MODELOS.includes(model))
      throw new Error(`model inválido en el paso ${n}: usa haiku | sonnet | opus`);
    if (it.irreversible != null && typeof it.irreversible !== "boolean")
      throw new Error(`irreversible debe ser true/false (paso ${n})`);
    return {
      title: it.title.trim(),
      detail: typeof it.detail === "string" && it.detail.trim() ? it.detail.trim() : null,
      model,
      irreversible: it.irreversible === true,
    };
  });
}

export function lazoTools(rpc, secret) {
  async function lanzarLazo({ project, objetivo, items, max_forjas = 12, max_horas = 8 }) {
    if (typeof project !== "string" || !project.trim()) throw new Error("Falta project");
    if (typeof objetivo !== "string" || !objetivo.trim()) throw new Error("Falta el objetivo del lazo");
    if (!Number.isInteger(max_forjas) || max_forjas < 1) throw new Error("max_forjas debe ser un entero >= 1");
    if (typeof max_horas !== "number" || !(max_horas > 0)) throw new Error("max_horas debe ser > 0");
    return await rpc("yq_lanzar_lazo", {
      p_token: secret,
      p_proyecto: project.trim(),
      p_objetivo: objetivo.trim(),
      p_items: normalizarItems(items),
      p_max_forjas: max_forjas,
      p_max_horas: max_horas,
      p_origen: "chat",
    });
  }

  async function lazoEstado({ project }) {
    if (typeof project !== "string" || !project.trim()) throw new Error("Falta project");
    return await rpc("yq_lazo_estado", { p_proyecto: project.trim() });
  }

  async function lazoAlto({ project, motivo = null }) {
    if (typeof project !== "string" || !project.trim()) throw new Error("Falta project");
    return await rpc("yq_lazo_alto", {
      p_token: secret,
      p_proyecto: project.trim(),
      p_motivo: motivo,
    });
  }

  return [
    {
      name: "lanzar_lazo",
      description:
        "SUELTA UN PLAN ACORDADO para que Yunque lo construya solo, con frenos (el LAZO). En una sola " +
        "transacción: agrega los pasos como partidas (plan_items) al final del plan del proyecto, abre " +
        "un lazo (yunque.lazos) con sus topes y enciende el auto-piloto. Llamarla UNA vez, cuando Cesar " +
        "ya acordó los pasos en el chat. Cada paso debe ser autocontenido (el worker no ve esta " +
        "conversación). Marca irreversible=true todo paso que despliegue, publique, migre producción o " +
        "no se pueda deshacer: va SIEMPRE a la bandeja de aprobación de Cesar (la base además lo detecta " +
        "sola por heurística). Falla si ya hay un lazo corriendo en el proyecto.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Proyecto: nombre (ej. 'Yunque', 'ORYM') o UUID." },
          objetivo: { type: "string", description: "El QUÉ que pidió Cesar, literal: el objetivo del lazo." },
          items: {
            type: "array",
            description: "Los pasos, en orden.",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "Título corto del paso." },
                detail: { type: "string", description: "Instrucción completa y autocontenida, con criterios de éxito." },
                model: { type: "string", enum: MODELOS, description: "haiku (ligero) | sonnet (medio) | opus (pesado). Omitir = el que elija el piloto." },
                irreversible: { type: "boolean", description: "true = siempre a la bandeja (despliegue, publicación, migración de producción…)." },
              },
              required: ["title"],
            },
          },
          max_forjas: { type: "number", description: "Tope de forjas encadenadas (avance + re-forjas). Default 12." },
          max_horas: { type: "number", description: "Tope de horas del lazo. Default 8." },
        },
        required: ["project", "objetivo", "items"],
      },
      handler: lanzarLazo,
    },
    {
      name: "lazo_estado",
      lectura: true,
      description:
        "Cómo va el LAZO de un proyecto: estado (corriendo | pausado | tope | alto | terminado), forjas " +
        "usadas vs tope, horas, avance de partidas (hechas, en bandeja, irreversibles pendientes) y el " +
        "último aviso lazo.paso ('Paso N/M hecho…'). Usar cuando Cesar pregunta '¿cómo va el lazo?'.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Proyecto: nombre o UUID." },
        },
        required: ["project"],
      },
      handler: lazoEstado,
    },
    {
      name: "lazo_alto",
      description:
        "EL FRENO. Llamarla en cuanto Cesar diga 'ALTO' sobre un proyecto: pone el lazo corriendo en " +
        "estado=alto, apaga el auto-piloto del proyecto y deja el evento lazo.alto en la bitácora. El job " +
        "que esté corriendo termina su paso; no se forja nada más. Si no había lazo, igual apaga el piloto.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Proyecto: nombre o UUID." },
          motivo: { type: "string", description: "Por qué se frena (default: 'ALTO de Cesar (desde el chat)')." },
        },
        required: ["project"],
      },
      handler: lazoAlto,
    },
  ];
}
