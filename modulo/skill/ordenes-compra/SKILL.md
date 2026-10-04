---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia — maestros, reglas de control RC1–RC10 y qué entrega el agente. Úsese al preparar o validar una OC.
---

# Conocimiento del proceso de Órdenes de Compra

> Nota: el cuerpo de esta skill es el mismo conocimiento de
> `src/knowledge/ordenes-compra.md` que consulta la aplicación.

Este documento describe el proceso y las reglas de negocio. **No** contiene datos
de casos: esos salen de las herramientas.

## El proceso

Cada compra llega por correo con tres piezas: la **solicitud** (Excel
normalizado a JSON), la **cotización** del proveedor (texto) y el **correo de
aprobación** del líder. A veces llega también una **factura** (caso retroactivo).
La analista debía digitar todo en SAP a mano; el agente lo automatiza: lee,
valida, construye la OC, genera la evidencia y la crea en el SAP simulado.

## Maestros (fuente de verdad)

- **proveedores**: código SAP, NIT, nombre, condiciones de pago por defecto,
  indicador de IVA por defecto, y si está activo.
- **centros de costo**: subáreas válidas y aprobadores con su tope de aprobación.
- **indicadores de IVA**: C0 (0%), C1 (19%), C2 (5%).
- **condiciones de pago**: Z000 (inmediato), Z015, Z030, Z060 (días).

## Reglas de control

**Bloqueos** (impiden crear la OC):
- **RC1**: el proveedor debe existir (por NIT; si no hay NIT, por nombre) y estar activo.
- **RC2**: la aprobación debe existir, decir "Aprobado" y venir de un aprobador del centro de costo.
- **RC3**: el valor total no puede superar el tope del aprobador.
- **RC4**: la subárea debe pertenecer al centro de costo.
- **RC10**: cantidad × valor unitario debe igualar el valor total (± 1).

**Confirmaciones** (requieren un "sí" explícito del usuario):
- **RC5**: si la cotización difiere más de 2 % de la solicitud, o no hay cotización.
- **RC6**: si no viene el indicador de IVA, se deriva del proveedor y se confirma.
- **RC8**: si hay una factura con fecha anterior a la solicitud, la OC es
  **retroactiva**; se marca y se confirma.
- **RC9**: si la fecha de aprobación es anterior a la solicitud.

**Derivados** (solo se informan):
- **RC7**: si no vienen las condiciones de pago, se derivan del proveedor.

## Qué entrega el agente

- La OC lista como quedaría en SAP (payload validado).
- La evidencia de aprobación en texto, con su huella `sha256`.
- Un registro en el log de control (`out/control.csv`) por cada intento, marcando
  si fue creada, bloqueada o pendiente, y si es retroactiva.
