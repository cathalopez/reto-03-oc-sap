// Adaptador SAP — interfaz obligatoria (PRD 7.4) + esquema zod de la Orden de Compra.
// La interfaz desacopla el agente de SAP: hoy usamos un mock de archivos,
// mañana una implementación real (OData/BAPI) sin tocar las herramientas.

import { z } from "zod";

/** Esquema de la Orden de Compra, inspirado en la API de OC de SAP. */
export const ordenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({
    codigo_sap: z.string(),
    nit: z.string(),
    nombre: z.string(),
  }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(), // código, ej. "Z030"
  aprobador: z.object({
    email: z.string(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string(),
  }),
  posiciones: z
    .array(
      z.object({
        numero: z.number(), // 10, 20, 30...
        descripcion: z.string().max(40), // límite SAP de texto breve
        cantidad: z.number(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(), // código, ej. "C1"
      }),
    )
    .min(1),
  excepciones: z.array(
    z.object({
      codigo: z.string(),
      detalle: z.string(),
      confirmado_por: z.string().nullable(),
    }),
  ),
});

export type OrdenCompra = z.infer<typeof ordenCompraSchema>;

/** Contrato que cualquier implementación de SAP (mock o real) debe cumplir. */
export interface SapAdapter {
  consultarProveedor(
    nit: string,
  ): Promise<{ codigo_sap: string; activo: boolean } | null>;
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>;
  buscarOrdenPorReferencia(
    solicitud_id: string,
  ): Promise<{ numero_oc: string; fecha: string } | null>;
}
