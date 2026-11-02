// Tests de las tools de TARJETAS (Y7-MCP-RAILWAY-TARJETAS).
// Levanta src/server.js de verdad contra un Supabase FALSO (http local), como test/ro.test.js.
//  · las 6 tools existen; con la llave de lectura solo se ven/ejecutan las 4 de lectura;
//  · decidir_tarjeta / comentar_tarjeta dan 403 con la llave de lectura SIN tocar el stub;
//  · con la llave completa, decidir_tarjeta manda p_token y NUNCA un canal;
//  · un «no» sin razón no llega al stub; la descripción trae la regla literal.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = "secreto-completo-de-prueba";
const RO = "llave-de-lectura-de-prueba";
const ID = "11111111-1111-4111-8111-111111111111";

const LECTURA = ["tarjetas", "rendimiento", "planta", "alertas_cabina"];
const ESCRITURA = ["decidir_tarjeta", "comentar_tarjeta"];
const FRASE =
  "Solo con una respuesta explícita de Cesar en esta conversación. Repítele la decisión antes de llamar. " +
  "La puerta 8 pide confirmado=true en una segunda llamada.";

let stub, calls, base, proc;

function freePort() {
  return new Promise((res) => {
    const s = http.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

before(async () => {
  calls = [];
  stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const fn = req.url.replace("/rest/v1/rpc/", "");
      calls.push({ fn, args: body ? JSON.parse(body) : {} });
      res.setHeader("Content-Type", "application/json");
      if (fn === "yq_tarjetas") return res.end(JSON.stringify({ filtro: "todas", total: 1, tarjetas: [{ id: ID, titulo: "T" }] }));
      if (fn === "yq_rendimiento") return res.end(JSON.stringify([{ id: "produccion_semana", valor: 3, estado: "ok" }]));
      if (fn === "yq_planta") return res.end(JSON.stringify([{ proyecto: "P" }]));
      if (fn === "yq_alertas_cabina") return res.end(JSON.stringify({ total: 0, alertas: [] }));
      if (fn === "yq_decidir_tarjeta") return res.end(JSON.stringify({ ok: false, error: "canal claude-chat remoto apagado" }));
      if (fn === "yq_comentar_tarjeta") return res.end(JSON.stringify({ ok: false, error: "canal claude-chat remoto apagado" }));
      res.end("[]");
    });
  });
  await new Promise((r) => stub.listen(0, r));
  const port = await freePort();
  proc = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      SUPABASE_URL: `http://127.0.0.1:${stub.address().port}`,
      SUPABASE_KEY: "anon-de-prueba",
      MCP_SECRET: SECRET,
      MCP_RO_SECRET: RO,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server.js no arrancó")), 10000);
    proc.stdout.on("data", (d) => {
      if (String(d).includes("escuchando")) { clearTimeout(t); resolve(); }
    });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error("server.js salió con " + c)); });
  });
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  proc?.kill();
  stub?.close();
});

async function mcp(method, params = {}, token = SECRET) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: await res.json() };
}
const llamar = (name, args, token = SECRET) => mcp("tools/call", { name, arguments: args }, token);
const texto = (r) => JSON.parse(r.body.result.content[0].text);

test("las 6 tools existen con la llave completa", async () => {
  const names = (await mcp("tools/list")).body.result.tools.map((t) => t.name);
  for (const n of [...LECTURA, ...ESCRITURA]) assert.ok(names.includes(n), `falta ${n}`);
});

test("con la llave de lectura solo se ven las 4 de lectura", async () => {
  const names = (await mcp("tools/list", {}, RO)).body.result.tools.map((t) => t.name);
  for (const n of LECTURA) assert.ok(names.includes(n), `falta ${n}`);
  for (const n of ESCRITURA) assert.ok(!names.includes(n), `${n} no debe verse con la llave de lectura`);
  const init = await mcp("initialize", {}, RO);
  assert.match(init.body.result.instructions, /tarjetas/);
});

test("lectura: las 4 responden con la llave de lectura y nunca mandan p_token", async () => {
  const antes = calls.length;
  assert.equal(texto(await llamar("tarjetas", { filtro: "Decisiones" }, RO)).tarjetas[0].id, ID);
  assert.equal(texto(await llamar("rendimiento", {}, RO)).metricas[0].id, "produccion_semana");
  assert.equal(texto(await llamar("planta", {}, RO)).proyectos[0].proyecto, "P");
  assert.equal(texto(await llamar("alertas_cabina", { limite: 5 }, RO)).total, 0);
  const nuevas = calls.slice(antes);
  assert.deepEqual(nuevas.map((c) => c.fn), ["yq_tarjetas", "yq_rendimiento", "yq_planta", "yq_alertas_cabina"]);
  for (const c of nuevas) assert.ok(!("p_token" in c.args), `${c.fn} recibió p_token`);
  assert.equal(nuevas[0].args.p_filtro, "Decisiones");
});

test("con la llave de lectura, decidir_tarjeta y comentar_tarjeta dan 403 sin tocar el stub", async () => {
  for (const [name, args] of [
    ["decidir_tarjeta", { id: ID, decision: "si" }],
    ["comentar_tarjeta", { id: ID, texto: "hola" }],
  ]) {
    const antes = calls.length;
    const r = await llamar(name, args, RO);
    assert.equal(r.status, 403, `${name} no fue rechazada`);
    assert.equal(r.body.error.code, -32003);
    assert.equal(calls.length, antes, `${name} tocó la base`);
  }
});

test("con la llave completa, decidir_tarjeta manda p_token y NUNCA un canal", async () => {
  const r = await llamar("decidir_tarjeta", { id: ID, decision: "si", confirmado: true, canal: "pc", p_canal: "pc" });
  assert.equal(texto(r).error, "canal claude-chat remoto apagado");
  const c = calls.at(-1);
  assert.equal(c.fn, "yq_decidir_tarjeta");
  assert.equal(c.args.p_token, SECRET);
  assert.equal(c.args.p_id, ID);
  assert.equal(c.args.p_decision, "si");
  assert.equal(c.args.p_confirmado, true);
  assert.deepEqual(Object.keys(c.args).sort(), ["p_confirmado", "p_decision", "p_id", "p_razon", "p_token"]);
  assert.ok(!Object.keys(c.args).some((k) => /canal/i.test(k)), "no hay argumento de canal");
  const t = (await mcp("tools/list")).body.result.tools.find((x) => x.name === "decidir_tarjeta");
  assert.ok(!("canal" in t.inputSchema.properties), "el esquema no ofrece canal");
});

test("comentar_tarjeta manda p_token", async () => {
  await llamar("comentar_tarjeta", { id: ID, texto: "un comentario" });
  const c = calls.at(-1);
  assert.equal(c.fn, "yq_comentar_tarjeta");
  assert.equal(c.args.p_token, SECRET);
  assert.equal(c.args.p_texto, "un comentario");
});

test("un «no» sin razón no llega al stub; una decisión inválida tampoco", async () => {
  for (const args of [
    { id: ID, decision: "no" },
    { id: ID, decision: "no", razon: "   " },
    { id: ID, decision: "rechazar" },
  ]) {
    const antes = calls.length;
    const r = await llamar("decidir_tarjeta", args);
    assert.ok(r.body.error, `debía fallar: ${JSON.stringify(args)}`);
    assert.equal(calls.length, antes, "tocó la base");
  }
  const antes = calls.length;
  await llamar("decidir_tarjeta", { id: ID, decision: "no", razon: "falta el precio" });
  assert.equal(calls.length, antes + 1);
  assert.equal(calls.at(-1).args.p_razon, "falta el precio");
});

test("la descripción de decidir_tarjeta trae la frase literal", async () => {
  const t = (await mcp("tools/list")).body.result.tools.find((x) => x.name === "decidir_tarjeta");
  assert.ok(t.description.includes(FRASE));
});
