// Implementación simulada de SapAdapter sobre archivos en out/sap/.
// Asigna números secuenciales desde 4500000001 y garantiza idempotencia
// por solicitud_id (crear dos veces la misma solicitud devuelve la misma OC).

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { SapAdapter, OrdenCompra } from "./adapter.ts";

type Registro = { numero_oc: string; fecha: string; orden: OrdenCompra };

export function createSapMock(directory: string): SapAdapter {
  const sapDir = join(directory, "out", "sap");
  const ordenesFile = join(sapDir, "ordenes.jsonl");
  const proveedoresFile = join(
    directory,
    "fixtures",
    "reto-03",
    "maestros",
    "proveedores.json",
  );

  function leerTodas(): Registro[] {
    if (!existsSync(ordenesFile)) return [];
    return readFileSync(ordenesFile, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Registro);
  }

  return {
    async consultarProveedor(nit) {
      const soloDigitos = (s: string) => s.replace(/\D/g, "");
      const proveedores = JSON.parse(
        readFileSync(proveedoresFile, "utf8"),
      ) as Array<{ codigo_sap: string; nit: string; activo: boolean }>;
      const p = proveedores.find(
        (x) => soloDigitos(x.nit) === soloDigitos(nit),
      );
      return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null;
    },

    async crearOrden(orden) {
      mkdirSync(sapDir, { recursive: true });
      const registros = leerTodas();
      const numero_oc = (4500000001 + registros.length).toString();
      const fecha = new Date().toISOString();
      appendFileSync(
        ordenesFile,
        JSON.stringify({ numero_oc, fecha, orden }) + "\n",
      );
      return { numero_oc, fecha };
    },

    async buscarOrdenPorReferencia(solicitud_id) {
      const encontrada = leerTodas().find(
        (r) => r.orden.referencia.solicitud_id === solicitud_id,
      );
      return encontrada
        ? { numero_oc: encontrada.numero_oc, fecha: encontrada.fecha }
        : null;
    },
  };
}
