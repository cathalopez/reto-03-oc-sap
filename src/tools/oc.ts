// Herramientas del agente de Órdenes de Compra. Cada export es una herramienta
// cuyo nombre visible para el modelo es oc_<export> (ej. oc_leer_paquete).
// REGLA DE ORO: las herramientas son la ÚNICA fuente de valores que el agente
// puede afirmar. Nunca lanzan: devuelven un string JSON { ok, data } | { ok:false, error }.

import { z } from "zod";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ordenCompraSchema, type OrdenCompra } from "../sap/adapter.ts";
import { createSapMock } from "../sap/mock.ts";

// ───────────────────────── Contexto y tipo de herramienta ─────────────────────────

export type Ctx = { directory: string; sessionId: string };

export type Tool = {
  description: string;
  args: z.ZodRawShape;
  execute: (args: Record<string, unknown>, ctx: Ctx) => Promise<string>;
};

const ok = (data: unknown) => JSON.stringify({ ok: true, data });
const fail = (error: string) => JSON.stringify({ ok: false, error });

// ───────────────────────── Utilidades ─────────────────────────

/** Quita tildes, pasa a minúsculas, quita puntos y colapsa espacios. */
function normTexto(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Deja solo dígitos (para comparar NIT escritos de distintas formas). */
const soloDigitos = (s: string): string => s.replace(/\D/g, "");

/** "COP 11.400.000" → 11400000. Los puntos son separadores de miles. */
function parseMontoCOP(s: string): number {
  return Number(s.replace(/[^\d]/g, ""));
}

/** Toma la parte de fecha YYYY-MM-DD de un string ISO o con hora. */
function soloFecha(s: string): string {
  const m = s.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : s;
}

function leerJSON<T>(ruta: string): T {
  return JSON.parse(readFileSync(ruta, "utf8")) as T;
}

function registrarLog(ctx: Ctx, entrada: Record<string, unknown>): void {
  const logFile = join(ctx.directory, "out", "log.jsonl");
  mkdirSync(join(ctx.directory, "out"), { recursive: true });
  appendFileSync(
    logFile,
    JSON.stringify({ ts: new Date().toISOString(), ...entrada }) + "\n",
  );
}

// ───────────────────────── Tipos de dominio ─────────────────────────

type Solicitud = {
  solicitud_id: string;
  solicitante: string;
  proveedor_nombre: string;
  proveedor_nit?: string;
  descripcion: string;
  centro_costo: string;
  subarea: string;
  cantidad: number;
  valor_unitario: number;
  valor_total: number;
  moneda: string;
  indicador_iva?: string;
  condiciones_pago?: string;
  fecha_solicitud: string;
};

type Paquete = {
  correo: { id: string; de: string; asunto: string; fecha: string };
  solicitud: Solicitud;
  cotizacion: {
    proveedor: string;
    nit: string | null;
    ref: string | null;
    total: number;
    moneda: string;
    validez_hasta: string | null;
    texto: string;
  } | null;
  aprobacion: {
    de: string;
    fecha: string;
    aprobado: boolean;
    texto: string;
  } | null;
  factura: { numero: string; fecha: string; total: number } | null;
};

type Proveedor = {
  codigo_sap: string;
  nit: string;
  nombre: string;
  condiciones_pago_default: string;
  indicador_iva_default: string;
  activo: boolean;
};

type CentroCosto = {
  centro_costo: string;
  nombre: string;
  subareas: string[];
  aprobadores: { email: string; nombre: string; tope: number }[];
};

// ───────────────────────── Carga de maestros ─────────────────────────

function maestrosDir(ctx: Ctx): string {
  return join(ctx.directory, "fixtures", "reto-03", "maestros");
}

function cargarProveedores(ctx: Ctx): Proveedor[] {
  return leerJSON<Proveedor[]>(join(maestrosDir(ctx), "proveedores.json"));
}
function cargarCentros(ctx: Ctx): CentroCosto[] {
  return leerJSON<CentroCosto[]>(join(maestrosDir(ctx), "centros-costo.json"));
}

// ───────────────────────── Parseo de cotización y factura ─────────────────────────

function parseCotizacion(texto: string): Paquete["cotizacion"] {
  const prov = texto.match(/Proveedor:\s*(.+)/i)?.[1]?.trim() ?? "";
  const nitRaw = texto.match(/NIT:\s*([\d.\-]+)/i)?.[1] ?? null;
  const ref = texto.match(/COTIZACI[OÓ]N\s+(\S+)/i)?.[1] ?? null;
  const totalRaw =
    texto.match(/TOTAL[^:]*:\s*COP\s*([\d.]+)/i)?.[1] ?? null;
  const validez = texto.match(/Validez[^:]*:\s*(.+)/i)?.[1]?.trim() ?? null;
  return {
    proveedor: prov,
    nit: nitRaw ? soloDigitos(nitRaw) : null,
    ref,
    total: totalRaw ? parseMontoCOP(totalRaw) : 0,
    moneda: "COP",
    validez_hasta: validez,
    texto,
  };
}

function parseFactura(texto: string): Paquete["factura"] {
  const numero =
    texto.match(/No\.\s*([A-Za-z0-9\-]+)/)?.[1] ??
    texto.match(/FACTURA[^\n]*?([A-Z]{2}-\d+)/)?.[1] ??
    "";
  const fecha = soloFecha(
    texto.match(/emisi[oó]n:\s*(\d{4}-\d{2}-\d{2})/i)?.[1] ?? "",
  );
  const totalRaw = texto.match(/TOTAL:\s*COP\s*([\d.]+)/i)?.[1] ?? null;
  return { numero, fecha, total: totalRaw ? parseMontoCOP(totalRaw) : 0 };
}

// ───────────────────────── Lógica de carga del paquete ─────────────────────────

function casoDir(ctx: Ctx, caso: string): string {
  return join(ctx.directory, "fixtures", "reto-03", "solicitudes", caso);
}

function construirPaquete(ctx: Ctx, caso: string): Paquete {
  const dir = casoDir(ctx, caso);
  const correoRaw = leerJSON<{
    id: string;
    de: string;
    asunto: string;
    fecha: string;
  }>(join(dir, "correo.json"));
  const solicitud = leerJSON<Solicitud>(join(dir, "solicitud.json"));

  const cotRuta = join(dir, "cotizacion.txt");
  const cotizacion = existsSync(cotRuta)
    ? parseCotizacion(readFileSync(cotRuta, "utf8"))
    : null;

  const aprRuta = join(dir, "aprobacion.json");
  let aprobacion: Paquete["aprobacion"] = null;
  if (existsSync(aprRuta)) {
    const a = leerJSON<{ de: string; fecha: string; cuerpo: string }>(aprRuta);
    aprobacion = {
      de: a.de,
      fecha: soloFecha(a.fecha),
      aprobado: /aprobad/i.test(a.cuerpo),
      texto: a.cuerpo,
    };
  }

  const facRuta = join(dir, "factura.txt");
  const factura = existsSync(facRuta)
    ? parseFactura(readFileSync(facRuta, "utf8"))
    : null;

  return {
    correo: {
      id: correoRaw.id,
      de: correoRaw.de,
      asunto: correoRaw.asunto,
      fecha: soloFecha(correoRaw.fecha),
    },
    solicitud,
    cotizacion,
    aprobacion,
    factura,
  };
}

// ───────────────────────── Validación (RC1–RC10) ─────────────────────────

type Excepcion = { codigo: string; detalle: string };
type Derivados = {
  indicador_iva?: { valor: string; fuente: string };
  condiciones_pago?: { valor: string; fuente: string };
};
type ResultadoValidacion = {
  apta: boolean;
  bloqueos: Excepcion[];
  confirmaciones: Excepcion[];
  derivados: Derivados;
  retroactiva: boolean;
  proveedor: Proveedor | null;
};

function validarPaquete(ctx: Ctx, paquete: Paquete): ResultadoValidacion {
  const sol = paquete.solicitud;
  const bloqueos: Excepcion[] = [];
  const confirmaciones: Excepcion[] = [];
  const derivados: Derivados = {};
  let retroactiva = false;

  const proveedores = cargarProveedores(ctx);
  const centros = cargarCentros(ctx);

  // RC1 — proveedor existe (por NIT; si no, por nombre) y está activo.
  let proveedor: Proveedor | null = null;
  if (sol.proveedor_nit) {
    proveedor =
      proveedores.find(
        (p) => soloDigitos(p.nit) === soloDigitos(sol.proveedor_nit as string),
      ) ?? null;
  }
  if (!proveedor) {
    proveedor =
      proveedores.find(
        (p) => normTexto(p.nombre) === normTexto(sol.proveedor_nombre),
      ) ?? null;
  }
  if (!proveedor) {
    bloqueos.push({
      codigo: "RC1",
      detalle: `Proveedor no existe en el maestro: ${sol.proveedor_nombre}`,
    });
  } else if (!proveedor.activo) {
    bloqueos.push({
      codigo: "RC1",
      detalle: `Proveedor inactivo en el maestro: ${proveedor.nombre}`,
    });
  }

  // RC10 — cantidad × valor_unitario = valor_total (± 1).
  const calculado = sol.cantidad * sol.valor_unitario;
  if (Math.abs(calculado - sol.valor_total) > 1) {
    bloqueos.push({
      codigo: "RC10",
      detalle: `cantidad×unitario (${calculado}) ≠ valor_total (${sol.valor_total})`,
    });
  }

  // RC4 — subárea pertenece al centro de costo.
  const centro = centros.find((c) => c.centro_costo === sol.centro_costo) ?? null;
  if (!centro) {
    bloqueos.push({
      codigo: "RC4",
      detalle: `Centro de costo inexistente: ${sol.centro_costo}`,
    });
  } else if (!centro.subareas.includes(sol.subarea)) {
    bloqueos.push({
      codigo: "RC4",
      detalle: `Subárea "${sol.subarea}" no pertenece a ${sol.centro_costo}`,
    });
  }

  // RC2 — aprobación existe, dice "Aprobado" y viene de un aprobador del centro.
  const aprobador =
    centro && paquete.aprobacion
      ? centro.aprobadores.find(
          (a) => normTexto(a.email) === normTexto(paquete.aprobacion!.de),
        )
      : undefined;
  if (!paquete.aprobacion || !paquete.aprobacion.aprobado) {
    bloqueos.push({
      codigo: "RC2",
      detalle: "No hay aprobación válida (falta el texto 'Aprobado')",
    });
  } else if (!aprobador) {
    bloqueos.push({
      codigo: "RC2",
      detalle: `${paquete.aprobacion.de} no es aprobador de ${sol.centro_costo}`,
    });
  }

  // RC3 — valor_total ≤ tope del aprobador.
  if (aprobador && sol.valor_total > aprobador.tope) {
    bloqueos.push({
      codigo: "RC3",
      detalle: `valor_total (${sol.valor_total}) supera el tope del aprobador (${aprobador.tope})`,
    });
  }

  // RC5 — cotización vs solicitud ≤ 2 %. Si excede o no hay cotización → confirmación.
  if (!paquete.cotizacion) {
    confirmaciones.push({
      codigo: "RC5",
      detalle: "No hay cotización para contrastar el valor",
    });
  } else {
    const dif =
      Math.abs(paquete.cotizacion.total - sol.valor_total) / sol.valor_total;
    if (dif > 0.02) {
      confirmaciones.push({
        codigo: "RC5",
        detalle: `Cotización (${paquete.cotizacion.total}) difiere ${(dif * 100).toFixed(1)}% de la solicitud (${sol.valor_total})`,
      });
    }
  }

  // RC6 — indicador_iva ausente → se deriva del proveedor + confirmación.
  if (!sol.indicador_iva) {
    if (proveedor) {
      derivados.indicador_iva = {
        valor: proveedor.indicador_iva_default,
        fuente: `maestro.proveedor (${proveedor.nombre})`,
      };
      confirmaciones.push({
        codigo: "RC6",
        detalle: `indicador_iva no informado; se deriva ${proveedor.indicador_iva_default} del proveedor`,
      });
    }
  }

  // RC7 — condiciones_pago ausente → se deriva del proveedor (solo informa).
  if (!sol.condiciones_pago && proveedor) {
    derivados.condiciones_pago = {
      valor: proveedor.condiciones_pago_default,
      fuente: `maestro.proveedor (${proveedor.nombre})`,
    };
  }

  // RC8 — factura con fecha < fecha_solicitud → retroactiva + confirmación.
  if (paquete.factura && paquete.factura.fecha < sol.fecha_solicitud) {
    retroactiva = true;
    confirmaciones.push({
      codigo: "RC8",
      detalle: `OC retroactiva: factura (${paquete.factura.fecha}) anterior a la solicitud (${sol.fecha_solicitud})`,
    });
  }

  // RC9 — fecha de aprobación ≥ fecha_solicitud; si no, confirmación.
  if (paquete.aprobacion && paquete.aprobacion.fecha < sol.fecha_solicitud) {
    confirmaciones.push({
      codigo: "RC9",
      detalle: `Aprobación (${paquete.aprobacion.fecha}) anterior a la solicitud (${sol.fecha_solicitud})`,
    });
  }

  return {
    apta: bloqueos.length === 0,
    bloqueos,
    confirmaciones,
    derivados,
    retroactiva,
    proveedor,
  };
}

// ───────────────────────── Construcción del payload ─────────────────────────

function unidadDesde(descripcion: string): "UN" | "H" | "MES" {
  const d = normTexto(descripcion);
  if (/\bhora/.test(d)) return "H";
  if (/\bmes/.test(d)) return "MES";
  return "UN";
}

function construirPayload(
  ctx: Ctx,
  paquete: Paquete,
): { orden: OrdenCompra; rutaTrazabilidad: string } {
  const sol = paquete.solicitud;
  const val = validarPaquete(ctx, paquete);
  const proveedor = val.proveedor;
  if (!proveedor) throw new Error("No se puede construir OC sin proveedor válido");

  const indicador_iva =
    sol.indicador_iva ?? val.derivados.indicador_iva?.valor ?? "C1";
  const condiciones_pago =
    sol.condiciones_pago ?? val.derivados.condiciones_pago?.valor ?? "Z030";

  const orden: OrdenCompra = {
    referencia: {
      solicitud_id: sol.solicitud_id,
      correo_id: paquete.correo.id,
      cotizacion_ref: paquete.cotizacion?.ref ?? null,
    },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: {
      codigo_sap: proveedor.codigo_sap,
      nit: proveedor.nit,
      nombre: proveedor.nombre,
    },
    moneda: sol.moneda === "USD" ? "USD" : "COP",
    condiciones_pago,
    aprobador: {
      email: paquete.aprobacion?.de ?? "",
      fecha_aprobacion: paquete.aprobacion?.fecha ?? "",
      evidencia_sha256: "", // se completa con oc_generar_evidencia
    },
    posiciones: [
      {
        numero: 10,
        descripcion: sol.descripcion.slice(0, 40),
        cantidad: sol.cantidad,
        unidad: unidadDesde(sol.descripcion),
        precio_unitario: sol.valor_unitario,
        centro_costo: sol.centro_costo,
        subarea: sol.subarea,
        indicador_iva,
      },
    ],
    excepciones: val.confirmaciones.map((c) => ({
      codigo: c.codigo,
      detalle: c.detalle,
      confirmado_por: null,
    })),
  };

  // Trazabilidad: cada valor del payload a su fuente.
  const trazabilidad = {
    "proveedor.codigo_sap": `maestro.proveedores (NIT ${proveedor.nit})`,
    "condiciones_pago": sol.condiciones_pago
      ? "solicitud"
      : "derivado:maestro.proveedores",
    "posiciones[0].indicador_iva": sol.indicador_iva
      ? "solicitud"
      : "derivado:maestro.proveedores",
    "posiciones[0].precio_unitario": "solicitud",
    "referencia.cotizacion_ref": paquete.cotizacion ? "cotizacion" : "null",
  };
  const outCaso = join(ctx.directory, "out", sol.solicitud_id);
  mkdirSync(outCaso, { recursive: true });
  const rutaTrazabilidad = join(outCaso, "trazabilidad.json");
  writeFileSync(rutaTrazabilidad, JSON.stringify(trazabilidad, null, 2));

  return { orden, rutaTrazabilidad };
}

// ───────────────────────── Evidencia de aprobación ─────────────────────────

function generarEvidencia(
  ctx: Ctx,
  caso: string,
): { ruta: string; sha256: string } {
  const dir = casoDir(ctx, caso);
  const a = leerJSON<{
    de: string;
    para: string;
    fecha: string;
    asunto: string;
    cuerpo: string;
  }>(join(dir, "aprobacion.json"));

  const contenido =
    `De: ${a.de}\n` +
    `Para: ${a.para}\n` +
    `Fecha: ${a.fecha}\n` +
    `Asunto: ${a.asunto}\n` +
    `----------------------------------------\n` +
    `${a.cuerpo}\n`;

  const sha256 = createHash("sha256").update(contenido, "utf8").digest("hex");

  const sol = leerJSON<{ solicitud_id: string }>(join(dir, "solicitud.json"));
  const outCaso = join(ctx.directory, "out", sol.solicitud_id);
  mkdirSync(outCaso, { recursive: true });
  const ruta = join(outCaso, "aprobacion.txt");
  writeFileSync(ruta, contenido + `\nsha256: ${sha256}\n`);

  return { ruta, sha256 };
}

// ───────────────────────── Registro en el log de control ─────────────────────────

function registrarControl(
  ctx: Ctx,
  fila: {
    solicitud_id: string;
    resultado: string;
    numero_oc: string;
    retroactiva: boolean;
    bloqueos: string;
    confirmaciones: string;
  },
): void {
  const ruta = join(ctx.directory, "out", "control.csv");
  mkdirSync(join(ctx.directory, "out"), { recursive: true });
  if (!existsSync(ruta)) {
    writeFileSync(
      ruta,
      "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n",
    );
  }
  appendFileSync(
    ruta,
    `${fila.solicitud_id},${fila.resultado},${fila.numero_oc},${fila.retroactiva},${fila.bloqueos},${fila.confirmaciones},${new Date().toISOString()}\n`,
  );
}

// ───────────────────────── HERRAMIENTAS (exports) ─────────────────────────

export const leer_paquete: Tool = {
  description:
    "Lee y normaliza el paquete de un caso (correo, solicitud, cotización, aprobación y factura si existe).",
  args: {
    caso: z
      .string()
      .describe("Carpeta del caso en fixtures/reto-03/solicitudes/ (ej. sol-001)"),
  },
  async execute(args, ctx) {
    const caso = String(args.caso);
    try {
      const paquete = construirPaquete(ctx, caso);
      registrarLog(ctx, { herramienta: "oc_leer_paquete", caso, ok: true });
      return ok(paquete);
    } catch (e) {
      registrarLog(ctx, { herramienta: "oc_leer_paquete", caso, ok: false });
      return fail(`No se pudo leer el paquete del caso "${caso}": ${(e as Error).message}`);
    }
  },
};

export const validar: Tool = {
  description:
    "Valida el paquete contra los maestros y las reglas RC1–RC10. Devuelve apta, bloqueos, confirmaciones, derivados y retroactiva.",
  args: {
    caso: z.string().describe("Carpeta del caso (ej. sol-001)"),
  },
  async execute(args, ctx) {
    const caso = String(args.caso);
    try {
      const paquete = construirPaquete(ctx, caso);
      const r = validarPaquete(ctx, paquete);
      registrarLog(ctx, {
        herramienta: "oc_validar",
        caso,
        ok: true,
        apta: r.apta,
      });
      return ok({
        apta: r.apta,
        bloqueos: r.bloqueos,
        confirmaciones: r.confirmaciones,
        derivados: r.derivados,
        retroactiva: r.retroactiva,
      });
    } catch (e) {
      return fail(`Error validando "${caso}": ${(e as Error).message}`);
    }
  },
};

export const construir_payload: Tool = {
  description:
    "Construye el payload de la OC (validado con zod) y guarda la trazabilidad de cada valor a su fuente.",
  args: {
    caso: z.string().describe("Carpeta del caso (ej. sol-001)"),
  },
  async execute(args, ctx) {
    const caso = String(args.caso);
    try {
      const paquete = construirPaquete(ctx, caso);
      const { orden, rutaTrazabilidad } = construirPayload(ctx, paquete);
      const validado = ordenCompraSchema.parse(orden); // garantiza el contrato
      registrarLog(ctx, { herramienta: "oc_construir_payload", caso, ok: true });
      return ok({ orden: validado, trazabilidad: rutaTrazabilidad });
    } catch (e) {
      return fail(`No se pudo construir el payload de "${caso}": ${(e as Error).message}`);
    }
  },
};

export const generar_evidencia: Tool = {
  description:
    "Genera la evidencia de aprobación en texto (out/<caso>/aprobacion.txt) con su huella sha256.",
  args: {
    caso: z.string().describe("Carpeta del caso (ej. sol-001)"),
  },
  async execute(args, ctx) {
    const caso = String(args.caso);
    try {
      const r = generarEvidencia(ctx, caso);
      registrarLog(ctx, {
        herramienta: "oc_generar_evidencia",
        caso,
        ok: true,
        sha256: r.sha256,
      });
      return ok(r);
    } catch (e) {
      return fail(`No se pudo generar la evidencia de "${caso}": ${(e as Error).message}`);
    }
  },
};

export const crear: Tool = {
  description:
    "Crea la OC en el SAP simulado. Solo procede si es apta y, si hay confirmaciones, si confirmado=true. Idempotente por solicitud_id.",
  args: {
    caso: z.string().describe("Carpeta del caso (ej. sol-001)"),
    confirmado: z
      .boolean()
      .optional()
      .describe("true si el usuario confirmó explícitamente las excepciones"),
  },
  async execute(args, ctx) {
    const caso = String(args.caso);
    const confirmado = args.confirmado === true;
    try {
      const paquete = construirPaquete(ctx, caso);
      const val = validarPaquete(ctx, paquete);

      if (!val.apta) {
        const motivos = val.bloqueos.map((b) => `${b.codigo}: ${b.detalle}`).join("; ");
        registrarControl(ctx, {
          solicitud_id: paquete.solicitud.solicitud_id,
          resultado: "bloqueada",
          numero_oc: "",
          retroactiva: val.retroactiva,
          bloqueos: val.bloqueos.map((b) => b.codigo).join("|"),
          confirmaciones: val.confirmaciones.map((c) => c.codigo).join("|"),
        });
        return fail(`OC bloqueada. ${motivos}`);
      }

      if (val.confirmaciones.length > 0 && !confirmado) {
        const pend = val.confirmaciones.map((c) => `${c.codigo}: ${c.detalle}`).join("; ");
        registrarControl(ctx, {
          solicitud_id: paquete.solicitud.solicitud_id,
          resultado: "pendiente_confirmacion",
          numero_oc: "",
          retroactiva: val.retroactiva,
          bloqueos: "",
          confirmaciones: val.confirmaciones.map((c) => c.codigo).join("|"),
        });
        return fail(`Requiere confirmación explícita. ${pend}`);
      }

      // Evidencia + payload (completando el sha256 en el payload).
      const evidencia = generarEvidencia(ctx, caso);
      const { orden } = construirPayload(ctx, paquete);
      orden.aprobador.evidencia_sha256 = evidencia.sha256;
      if (confirmado) {
        orden.excepciones = orden.excepciones.map((x) => ({
          ...x,
          confirmado_por: "usuario",
        }));
      }

      const sap = createSapMock(ctx.directory);
      const existente = await sap.buscarOrdenPorReferencia(
        paquete.solicitud.solicitud_id,
      );
      if (existente) {
        registrarLog(ctx, {
          herramienta: "oc_crear",
          caso,
          ok: true,
          idempotente: true,
          numero_oc: existente.numero_oc,
        });
        return ok({
          numero_oc: existente.numero_oc,
          fecha: existente.fecha,
          idempotente: true,
        });
      }

      const creada = await sap.crearOrden(orden);
      registrarControl(ctx, {
        solicitud_id: paquete.solicitud.solicitud_id,
        resultado: "creada",
        numero_oc: creada.numero_oc,
        retroactiva: val.retroactiva,
        bloqueos: "",
        confirmaciones: val.confirmaciones.map((c) => c.codigo).join("|"),
      });
      registrarLog(ctx, {
        herramienta: "oc_crear",
        caso,
        ok: true,
        idempotente: false,
        numero_oc: creada.numero_oc,
      });
      return ok({ ...creada, idempotente: false });
    } catch (e) {
      return fail(`No se pudo crear la OC de "${caso}": ${(e as Error).message}`);
    }
  },
};

/** Registro de herramientas: nombre visible para el modelo → herramienta. */
export const tools: Record<string, Tool> = {
  oc_leer_paquete: leer_paquete,
  oc_validar: validar,
  oc_construir_payload: construir_payload,
  oc_generar_evidencia: generar_evidencia,
  oc_crear: crear,
};
