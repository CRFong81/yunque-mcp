// Tests de MCP-RO: la llave de SOLO LECTURA.
// Levanta src/server.js de verdad contra un Supabase FALSO (http local) dos veces:
//  A) con MCP_RO_SECRET explícito; B) sin él (llave derivada por HMAC de MCP_SECRET).
// Con la llave de lectura: lista/ejecuta solo tools de lectura, rechaza toda escritura con 403
// SIN tocar la base, y nunca manda p_token. La llave completa sigue igual.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SECRET = "secreto-completo-de-prueba";
const RO = "llave-de-lectura-de-prueba";
const RO_DERIVADA = crypto.createHmac("sha256", SECRET).update("yunque-mcp-ro-v1").digest("hex");

// La lista cerrada de lo que la llave de lectura puede ver. Una tool nueva queda FUERA por
// defecto (sin `lectura: true` es escritura): si alguien la marca, esta prueba lo obliga a decidir.
const LECTURA = [
  "estado", "proyectos", "mps", "jobs", "tareas", "eventos", "bitacora", "alcance",
  "guia", "list_lecciones", "lazo_estado",
];
const ESCRITURA = {
  forjar: { titulo: "t", prompt: "p", proyecto: "PRUEBA-LOOP" },
  cancelar_job: { job_id: "00000000-0000-0000-0000-000000000000" },
  crear_tarea: { titulo: "t" },
  completar_tarea: { id: "00000000-0000-0000-0000-000000000000" },
  add_leccion: { titulo: "t", leccion: "l" },
  lanzar_lazo: { project: "PRUEBA-LOOP", objetivo: "o", items: [{ title: "a" }] },
  lazo_alto: { project: "PRUEBA-LOOP" },
};

let stub, stubCalls;
const servers = [];

function freePort() {
  return new Promise((res) => {
    const s = http.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

async function arrancar(envExtra) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      SUPABASE_URL: `http://127.0.0.1:${stub.address().port}`,
      SUPABASE_KEY: "anon-de-prueba",
      MCP_SECRET: SECRET,
      MCP_RO_SECRET: "",
      ...envExtra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(proc);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server.js no arrancó")), 10000);
    proc.stdout.on("data", (d) => {
      if (String(d).includes("escuchando")) { clearTimeout(t); resolve(); }
    });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error("server.js salió con " + c)); });
  });
  return `http://127.0.0.1:${port}`;
}

let A, B; // A: MCP_RO_SECRET explícito · B: llave derivada

before(async () => {
  stubCalls = [];
  stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const fn = req.url.replace("/rest/v1/rpc/", "");
      stubCalls.push({ fn, args: body ? JSON.parse(body) : {} });
      res.setHeader("Content-Type", "application/json");
      if (fn === "yq_proyectos") return res.end(JSON.stringify([{ nombre: "PRUEBA-LOOP", estado: "activo", mps_hechos: 1, mps_total: 2 }]));
      if (fn === "yq_jobs") return res.end(JSON.stringify([{ id: "J1", status: "done" }]));
      if (fn === "yq_estado") return res.end(JSON.stringify({ runner: { vivo: true, ultimo_latido_hace_seg: 3 }, cola: { ejecutando: 0, pendientes: 0 } }));
      if (fn === "yq_forjar") return res.end(JSON.stringify({ ok: true, job_id: "J-NUEVO" }));
      res.end(JSON.stringify([]));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  A = await arrancar({ MCP_RO_SECRET: RO });
  B = await arrancar({});
});

after(() => {
  for (const s of servers) s.kill();
  stub?.close();
});

async function mcp(base, method, params = {}, token = SECRET, ruta = "header") {
  const url = ruta === "path" ? `${base}/mcp/${token}` : `${base}/mcp`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ruta === "header" && token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
  });
  return { status: res.status, body: await res.json() };
}
const texto = (r) => JSON.parse(r.body.result.content[0].text);

test("RO: tools/list publica SOLO las de lectura (lista cerrada)", async () => {
  const { status, body } = await mcp(A, "tools/list", {}, RO);
  assert.equal(status, 200);
  assert.deepEqual(body.result.tools.map((t) => t.name).sort(), [...LECTURA].sort());
  const init = await mcp(A, "initialize", {}, RO);
  assert.match(init.body.result.instructions, /SOLO LECTURA/);
});

test("RO: listar proyectos, jobs y estado funciona y nunca manda p_token", async () => {
  const antes = stubCalls.length;
  assert.equal(texto(await mcp(A, "tools/call", { name: "proyectos", arguments: {} }, RO)).proyectos[0].nombre, "PRUEBA-LOOP");
  assert.equal(texto(await mcp(A, "tools/call", { name: "jobs", arguments: { limite: 3 } }, RO)).jobs[0].id, "J1");
  assert.match(texto(await mcp(A, "tools/call", { name: "estado", arguments: {} }, RO)).resumen, /VIVO/);
  const nuevas = stubCalls.slice(antes);
  assert.deepEqual(nuevas.map((c) => c.fn), ["yq_proyectos", "yq_jobs", "yq_estado"]);
  for (const c of nuevas) assert.ok(!("p_token" in c.args), `${c.fn} recibió p_token`);
});

test("RO: forjar, cancelar_job y TODA escritura → 403 -32003 sin tocar la base", async () => {
  for (const ruta of ["header", "path"]) {
    for (const [name, args] of Object.entries(ESCRITURA)) {
      const antes = stubCalls.length;
      const r = await mcp(A, "tools/call", { name, arguments: args }, RO, ruta);
      assert.equal(r.status, 403, `${name} (${ruta}) no fue rechazada`);
      assert.equal(r.body.error.code, -32003);
      assert.match(r.body.error.message, /Solo lectura/);
      assert.equal(r.body.result, undefined);
      assert.equal(stubCalls.length, antes, `${name} (${ruta}) tocó la base`);
    }
  }
});

test("RO: la API de la cabina lee pero rechaza forjar sin tocar la base", async () => {
  const leer = await fetch(`${A}/cabina/${RO}/api`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "proyectos", args: {} }),
  });
  assert.equal(leer.status, 200);
  assert.equal((await leer.json()).proyectos[0].nombre, "PRUEBA-LOOP");
  const antes = stubCalls.length;
  const f = await fetch(`${A}/cabina/${RO}/api`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "forjar", args: ESCRITURA.forjar }),
  });
  assert.equal(f.status, 403);
  assert.equal(stubCalls.length, antes);
  assert.equal((await fetch(`${A}/cabina/${RO}/`)).status, 200);
});

test("llave completa: sigue viendo todo y forjar llega a la base con p_token", async () => {
  const { body } = await mcp(A, "tools/list");
  const names = body.result.tools.map((t) => t.name);
  for (const n of [...LECTURA, ...Object.keys(ESCRITURA)]) assert.ok(names.includes(n), `falta ${n}`);
  const r = await mcp(A, "tools/call", { name: "forjar", arguments: ESCRITURA.forjar });
  assert.equal(texto(r).job_id, "J-NUEVO");
  assert.equal(stubCalls.at(-1).fn, "yq_forjar");
  assert.equal(stubCalls.at(-1).args.p_token, SECRET);
});

test("llave equivocada → 401; con MCP_RO_SECRET explícito la derivada NO sirve", async () => {
  for (const t of ["otra-cosa", RO_DERIVADA, ""]) {
    const antes = stubCalls.length;
    const r = await mcp(A, "tools/call", { name: "proyectos", arguments: {} }, t);
    assert.equal(r.status, 401);
    assert.equal(stubCalls.length, antes);
  }
});

test("sin MCP_RO_SECRET: la llave derivada (HMAC) es de lectura y distinta de la completa", async () => {
  assert.notEqual(RO_DERIVADA, SECRET);
  const l = await mcp(B, "tools/list", {}, RO_DERIVADA);
  assert.deepEqual(l.body.result.tools.map((t) => t.name).sort(), [...LECTURA].sort());
  const antes = stubCalls.length;
  const f = await mcp(B, "tools/call", { name: "forjar", arguments: ESCRITURA.forjar }, RO_DERIVADA);
  assert.equal(f.status, 403);
  assert.equal(stubCalls.length, antes);
  assert.equal((await mcp(B, "tools/call", { name: "proyectos", arguments: {} }, RO)).status, 401);
});
