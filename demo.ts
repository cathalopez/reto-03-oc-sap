// demo.ts — Verificación determinista SIN modelo de lenguaje.
// Llama directamente a las herramientas sobre los 6 casos e imprime el resumen.
// Corre con: bun run demo.ts   (no requiere clave de ningún proveedor)

import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  leer_paquete,
  validar,
  crear,
  type Ctx,
  type Tool,
} from "./src/tools/oc.ts";

const directory = process.cwd();
const ctx: Ctx = { directory, sessionId: "demo" };

// out/ se limpia al inicio para que el resultado sea reproducible.
rmSync(join(directory, "out"), { recursive: true, force: true });

const casos = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"];

type Excepcion = { codigo: string; detalle: string };
type RespOk<T> = { ok: true; data: T };
type RespErr = { ok: false; error: string };
type Resp<T> = RespOk<T> | RespErr;

type PaqueteData = { solicitud: { solicitud_id: string } };
type ValidarData = {
  apta: boolean;
  bloqueos: Excepcion[];
  confirmaciones: Excepcion[];
  retroactiva: boolean;
};
type CrearData = { numero_oc: string; fecha: string; idempotente: boolean };

async function call<T>(t: Tool, args: Record<string, unknown>): Promise<Resp<T>> {
  return JSON.parse(await t.execute(args, ctx)) as Resp<T>;
}

const linea = () => console.log("─".repeat(78));

async function procesar(caso: string, confirmar: boolean): Promise<void> {
  linea();
  const paq = await call<PaqueteData>(leer_paquete, { caso });
  if (!paq.ok) {
    console.log(`${caso}: ERROR al leer → ${paq.error}`);
    return;
  }
  const v = await call<ValidarData>(validar, { caso });
  if (!v.ok) {
    console.log(`${caso}: ERROR al validar → ${v.error}`);
    return;
  }
  const { apta, bloqueos, confirmaciones, retroactiva } = v.data;

  console.log(`CASO ${caso}  (${paq.data.solicitud.solicitud_id})`);
  console.log(`  apta: ${apta}   retroactiva: ${retroactiva}`);
  if (bloqueos.length)
    console.log(`  bloqueos:       ${bloqueos.map((b) => `${b.codigo} ${b.detalle}`).join(" | ")}`);
  if (confirmaciones.length)
    console.log(`  confirmaciones: ${confirmaciones.map((c) => `${c.codigo} ${c.detalle}`).join(" | ")}`);

  const res = await call<CrearData>(crear, { caso, confirmado: confirmar });
  if (res.ok) {
    console.log(`  → OC ${res.data.numero_oc}  (idempotente: ${res.data.idempotente})`);
  } else {
    console.log(`  → sin OC: ${res.error}`);
  }
}

console.log("\n========== DEMO RETO 03 — Órdenes de Compra (sin modelo) ==========");

// Primera pasada: sin confirmar nada (vemos qué pide confirmación / se bloquea).
for (const caso of casos) {
  await procesar(caso, false);
}

// Segunda pasada dirigida: confirmaciones e idempotencia.
linea();
console.log("\n===== Segunda pasada: confirmaciones explícitas =====");
await procesar("sol-004", true); // cotización ≠ solicitud → se confirma y se crea
await procesar("sol-005", true); // retroactiva → se confirma y se crea
await procesar("sol-006", true); // IVA derivado → se confirma y se crea

linea();
console.log("\n===== Idempotencia: crear sol-001 por segunda vez =====");
const dup = await call<CrearData>(crear, { caso: "sol-001", confirmado: false });
console.log(
  dup.ok
    ? `sol-001 → OC ${dup.data.numero_oc} (idempotente: ${dup.data.idempotente})`
    : `sol-001 → ${dup.error}`,
);

linea();
console.log("\nRevisa out/control.csv y out/sap/ordenes.jsonl para el detalle.\n");
