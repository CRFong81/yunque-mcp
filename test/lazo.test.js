// Tests de LAZO-4: las tools lanzar_lazo / lazo_estado / lazo_alto.
//  1) unidad: lazoTools con un rpc falso (forma de los argumentos, validación local).
//  2) integración: levanta src/server.js de verdad contra un Supabase FALSO (http local) y
//     habla JSON-RPC por /mcp: tools/list, tools/call, auth, errores de la RPC.
// Sin red externa ni base real (la RPC se prueba aparte: db/run_test_lazo4.py).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lazoTools } from "../src/lazo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fakeRpc(respuesta = { ok: true }) {
  const calls = [];
  const rpc = async (fn, args) => {
    calls.push({ fn, args });
    return typeof respuesta === "function" ? respuesta(fn, args) : respuesta;
  };
  return { rpc, calls };
}
const tool = (tools, name) => tools.find((t) => t.name === name);

// ---------------- unidad ----------------

test("registra las tres tools con schema", () => {
  const tools = lazoTools(async () => null, "s");
  assert.deepEqual(tools.map((t) => t.name), ["lanzar_lazo", "lazo_estado", "lazo_alto"]);
  for (const t of tools) {
    assert.equal(typeof t.handler, "function");
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.description.length > 40);
  }
  assert.deepEqual(tool(tools, "lanzar_lazo").inputSchema.required, ["project", "objetivo", "items"]);
});

test("lanzar_lazo manda token, pasos normalizados y defaults 12/8", async () => {
  const { rpc, calls } = fakeRpc({ ok: true, lazo_id: "L1" });
  const r = await tool(lazoTools(rpc, "SECRETO"), "lanzar_lazo").handler({
    project: " Yunque ",
    objetivo: " Hacer X ",
    items: [
      { title: " Paso 1 ", detail: " hacer a ", model: "OPUS" },
      { title: "Paso 2", irreversible: true },
      { title: "Paso 3", detail: "   ", model: "" },
    ],
  });
  assert.deepEqual(r, { ok: true, lazo_id: "L1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, "yq_lanzar_lazo");
  assert.deepEqual(calls[0].args, {
    p_token: "SECRETO",
    p_proyecto: "Yunque",
    p_objetivo: "Hacer X",
    p_items: [
      { title: "Paso 1", detail: "hacer a", model: "opus", irreversible: false },
      { title: "Paso 2", detail: null, model: null, irreversible: true },
      { title: "Paso 3", detail: null, model: null, irreversible: false },
    ],
    p_max_forjas: 12,
    p_max_horas: 8,
    p_origen: "chat",
  });
});

test("lanzar_lazo respeta topes explícitos", async () => {
  const { rpc, calls } = fakeRpc();
  await tool(lazoTools(rpc, "s"), "lanzar_lazo").handler({
    project: "ORYM", objetivo: "o", items: [{ title: "a" }], max_forjas: 3, max_horas: 1.5,
  });
  assert.equal(calls[0].args.p_max_forjas, 3);
  assert.equal(calls[0].args.p_max_horas, 1.5);
});

test("lanzar_lazo rechaza entradas mal formadas SIN llamar a la base", async () => {
  const { rpc, calls } = fakeRpc();
  const h = tool(lazoTools(rpc, "s"), "lanzar_lazo").handler;
  const base = { project: "Yunque", objetivo: "o", items: [{ title: "a" }] };
  const malos = [
    [{ ...base, project: "" }, /Falta project/],
    [{ ...base, objetivo: "  " }, /objetivo/],
    [{ ...base, items: [] }, /al menos un paso/],
    [{ ...base, items: "a" }, /al menos un paso/],
    [{ ...base, items: [{ title: "a" }, { detail: "x" }] }, /paso 2/],
    [{ ...base, items: [{ title: "a", model: "gpt-4" }] }, /model inválido/],
    [{ ...base, items: [{ title: "a", irreversible: "si" }] }, /irreversible/],
    [{ ...base, max_forjas: 0 }, /max_forjas/],
    [{ ...base, max_forjas: 2.5 }, /max_forjas/],
    [{ ...base, max_horas: 0 }, /max_horas/],
    [{ ...base, max_horas: "8" }, /max_horas/],
  ];
  for (const [args, re] of malos) await assert.rejects(h(args), re);
  assert.equal(calls.length, 0);
});

test("lazo_estado es lectura sin token", async () => {
  const { rpc, calls } = fakeRpc({ lazo: { estado: "corriendo" } });
  const r = await tool(lazoTools(rpc, "s"), "lazo_estado").handler({ project: " QUANTIX " });
  assert.equal(r.lazo.estado, "corriendo");
  assert.deepEqual(calls, [{ fn: "yq_lazo_estado", args: { p_proyecto: "QUANTIX" } }]);
  await assert.rejects(tool(lazoTools(rpc, "s"), "lazo_estado").handler({}), /Falta project/);
});

test("lazo_alto manda token y motivo", async () => {
  const { rpc, calls } = fakeRpc({ ok: true, estado: "alto" });
  const t = tool(lazoTools(rpc, "TOK"), "lazo_alto");
  await t.handler({ project: "Yunque" });
  await t.handler({ project: "Yunque", motivo: "se ve mal" });
  assert.deepEqual(calls.map((c) => c.args), [
    { p_token: "TOK", p_proyecto: "Yunque", p_motivo: null },
    { p_token: "TOK", p_proyecto: "Yunque", p_motivo: "se ve mal" },
  ]);
  await assert.rejects(t.handler({ project: " " }), /Falta project/);
});

// ---------------- integración: server.js real + Supabase falso ----------------

let stub, server, stubCalls, serverUrl;
const SECRET = "secreto-de-prueba";
const ANON = "anon-de-prueba";

function freePort() {
  return new Promise((res) => {
    const s = http.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

before(async () => {
  stubCalls = [];
  stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const fn = req.url.replace("/rest/v1/rpc/", "");
      const args = body ? JSON.parse(body) : {};
      stubCalls.push({ fn, args, apikey: req.headers.apikey });
      res.setHeader("Content-Type", "application/json");
      if (fn === "yq_lazo_alto" && args.p_token !== SECRET) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ code: "P0001", message: "No autorizado" }));
      }
      if (fn === "yq_lanzar_lazo") return res.end(JSON.stringify({ ok: true, lazo_id: "L-1", pasos: args.p_items }));
      if (fn === "yq_lazo_estado") return res.end(JSON.stringify({ lazo: { estado: "corriendo", forjas: 2 } }));
      if (fn === "yq_lazo_alto") return res.end(JSON.stringify({ ok: true, estado: "alto" }));
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "no existe " + fn }));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  const port = await freePort();
  serverUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      SUPABASE_URL: `http://127.0.0.1:${stub.address().port}`,
      SUPABASE_KEY: ANON,
      MCP_SECRET: SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server.js no arrancó")), 10000);
    server.stdout.on("data", (d) => {
      if (String(d).includes("escuchando")) { clearTimeout(t); resolve(); }
    });
    server.on("exit", (c) => { clearTimeout(t); reject(new Error("server.js salió con " + c)); });
  });
});

after(() => {
  server?.kill();
  stub?.close();
});

async function mcp(method, params = {}, auth = `Bearer ${SECRET}`) {
  const res = await fetch(`${serverUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: await res.json() };
}

test("integración: tools/list publica las tres tools del lazo (y conserva las viejas)", async () => {
  const { body } = await mcp("tools/list");
  const names = body.result.tools.map((t) => t.name);
  for (const n of ["lanzar_lazo", "lazo_estado", "lazo_alto", "forjar", "guia", "add_leccion"])
    assert.ok(names.includes(n), `falta ${n}`);
  const init = await mcp("initialize");
  assert.match(init.body.result.instructions, /lanzar_lazo/);
});

test("integración: sin token el server responde 401 y no toca la base", async () => {
  const antes = stubCalls.length;
  const r = await mcp("tools/call", { name: "lazo_alto", arguments: { project: "Yunque" } }, null);
  assert.equal(r.status, 401);
  assert.equal(stubCalls.length, antes);
});

test("integración: tools/call lanzar_lazo llega a public.yq_lanzar_lazo con el token", async () => {
  const r = await mcp("tools/call", {
    name: "lanzar_lazo",
    arguments: { project: "PRUEBA-LOOP", objetivo: "tres pasos", items: [{ title: "a" }, { title: "b", irreversible: true }] },
  });
  const out = JSON.parse(r.body.result.content[0].text);
  assert.equal(out.lazo_id, "L-1");
  const c = stubCalls.at(-1);
  assert.equal(c.fn, "yq_lanzar_lazo");
  assert.equal(c.apikey, ANON);
  assert.equal(c.args.p_token, SECRET);
  assert.equal(c.args.p_items.length, 2);
  assert.equal(c.args.p_items[1].irreversible, true);
});

test("integración: lazo_estado y lazo_alto por JSON-RPC", async () => {
  const e = await mcp("tools/call", { name: "lazo_estado", arguments: { project: "Yunque" } });
  assert.equal(JSON.parse(e.body.result.content[0].text).lazo.estado, "corriendo");
  const a = await mcp("tools/call", { name: "lazo_alto", arguments: { project: "Yunque", motivo: "ALTO" } });
  assert.equal(JSON.parse(a.body.result.content[0].text).estado, "alto");
  assert.equal(stubCalls.at(-1).args.p_motivo, "ALTO");
});

test("integración: un error de validación vuelve como error JSON-RPC", async () => {
  const r = await mcp("tools/call", { name: "lanzar_lazo", arguments: { project: "Yunque", objetivo: "o", items: [] } });
  assert.match(r.body.error.message, /al menos un paso/);
});
