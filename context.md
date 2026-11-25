# Proyecto: Sistema de control financiero y análisis de rentabilidad para tienda de impresión 3D

## 1. Contexto del negocio

Actualmente opero una tienda dedicada a la compra y venta de productos relacionados con la impresión 3D, principalmente:

- Impresoras 3D Bambu Lab.
- Filamentos de diferentes materiales, marcas y colores.
- Accesorios para impresoras 3D.
- Refacciones.
- Consumibles y otros productos relacionados.

El negocio consiste en adquirir mercancía de proveedores y comercializarla a clientes finales.

**Este sistema estará dedicado exclusivamente a la operación comercial de la tienda.**

Tengo otra actividad de servicios de impresión 3D, pero se administra en un sistema completamente diferente y queda fuera del alcance de este proyecto.

La consolidación financiera entre ambas actividades se realizará posteriormente en Excel, mediante reportes exportados de cada sistema.

## 2. Sistemas actuales

### Clip — Punto de venta

Actualmente utilizo la aplicación Clip para:

- Registrar productos.
- Administrar inventario.
- Registrar ventas de mostrador.
- Procesar cobros.
- Consultar transacciones.
- Administrar métodos de pago.

Clip continuará siendo el sistema principal de punto de venta y control operativo de inventario.

No deseo desarrollar otro POS ni capturar manualmente cada venta en dos sistemas.

### Nuevo sistema — Control financiero

Quiero desarrollar un sistema o módulo ligero que se enfoque en:

- Registro de compras de mercancía.
- Registro de gastos.
- Registro o importación de ventas.
- Costos de adquisición.
- Rentabilidad por producto y categoría.
- Análisis financiero.
- Valor del inventario.
- Flujo de efectivo.
- Reportes mensuales.

El sistema debe complementar a Clip, no reemplazarlo.

## 3. Objetivo principal

Construir una aplicación que me permita responder:

1. ¿Cuánto vendió la tienda durante un periodo?
2. ¿Cuánto costó la mercancía vendida?
3. ¿Cuánta utilidad bruta generó?
4. ¿Cuánto pagué en comisiones de cobro?
5. ¿Cuáles fueron mis gastos operativos?
6. ¿Cuál fue la utilidad operativa mensual?
7. ¿Qué productos y categorías son más rentables?
8. ¿Cuánto capital tengo invertido en inventario?
9. ¿Qué productos tienen baja rotación?
10. ¿Cómo evoluciona la rentabilidad de la tienda mes a mes?
11. ¿Cuánto dinero entra y sale realmente?
12. ¿Qué tan rentable es el capital invertido en el negocio?

Priorizar la confiabilidad de los datos y la facilidad de uso sobre la cantidad de funcionalidades.

## 4. Alcance y restricciones

### Incluir

- Gestión de compras.
- Gestión de proveedores.
- Registro de gastos.
- Registro e importación de ingresos.
- Catálogo financiero de productos.
- Cálculo de costos y márgenes.
- Seguimiento del valor de inventario.
- Dashboard financiero.
- Reportes y exportaciones.
- Cierre mensual.

### Excluir

- Servicios de impresión 3D.
- Órdenes de producción.
- Administración de impresoras productivas.
- Cálculo de costos de fabricación.
- Control de horas de impresión.
- Gestión de múltiples unidades de negocio.
- Consolidación con otros negocios.
- Transferencias entre operaciones.
- Sistema de punto de venta.
- Procesamiento directo de pagos.
- Sustitución del inventario operativo de Clip.
- Contabilidad fiscal completa.

No incorporar arquitectura multi-tenant si no existe una necesidad concreta para este sistema.

## Decisión vigente: productos e inventario fuera del sistema

Por solicitud del propietario se retiran los módulos de Productos e Inventario, incluyendo sus rutas, formularios, requerimientos de apertura, indicadores y exportaciones. Las compras se capturan por importes y los saldos de apertura son monetarios. Conservar los registros históricos y las relaciones de compras existentes. El sistema registra cobros, compras, gastos y efectivo; no calcula existencias ni exige cortes de inventario. Las compras no equivalen automáticamente al costo de lo vendido. El costo se puede documentar externamente; mientras falte, la utilidad permanece pendiente. Esta decisión sustituye las propuestas anteriores de inventario por SKU o por totales que aparecen en el diseño original.

El propietario reitera que esta herramienta es financiera: el detalle por producto y venta pertenece al PDV. Impuestos y costos debe reutilizar los totales de compras, gastos, activos, pagos e IVA originales, sin recaptura ni duplicación. Reutilizar el tratamiento de gastos sin IVA recuperable; proponer UUID existentes sin acreditar IVA automáticamente. Priorizar cobros, pagos y flujo de caja en el dashboard. Para utilidad contable admitir únicamente un costo mensual agregado del PDV, sin exigir productos; no sustituirlo por todas las compras ni inventarlo cuando falte.

**Dashboard vigente:** no solicitar costo vendido ni presentar utilidad, márgenes, resultado operativo o resultado después de ISR. Mostrar cobros registrados (incluyendo Clip), compras pagadas, gastos y activos pagados y flujo disponible de Efectivo/Banco. Gráfica, desglose y exportación usan movimientos efectivos con sus signos; las transferencias internas se compensan. Excluir apertura, aportaciones y retiros del flujo de operación. Mantener estimaciones fiscales de la tienda y alertas reales de conciliación, devoluciones y recuperaciones, sin marcar el dashboard incompleto por costos no capturados. El costo mensual externo permanece como opción fuera del dashboard, sin ser requisito de esta vista.

**Convención visual de importes:** verde para entradas y valores a favor; rojo para salidas, cargos y valores negativos; negro para totales, referencias y saldos positivos; gris para cero o pendiente. Mostrar signos en movimientos y en indicadores de flujo para no depender solo del color. Una compra registrada sin pago conserva un total de referencia; no inventar una salida por colorearla. Los formatos y colores son de presentación y no cambian importes, movimientos ni exportaciones.

## Decisión vigente: operación sin conciliación por venta

Registrar ventas y comisiones configuradas automáticamente al importar. Las comisiones se identifican como calculadas según tarifa; no exigir comprobarlas individualmente ni mover dinero a Banco al revisar una venta. Registrar cada SPEI de Clip a Banco como una transferencia independiente por importe y fecha reales, agrupando ventas o transfiriendo parcialmente el saldo según corresponda. No duplicar ventas ni comisiones. Las diferencias se revisan al comparar los saldos reales de las tres cuentas al cierre del mes.

El cierre financiero usa tres revisiones y no exige costo vendido ni conciliación de cobros individuales. Las tarifas faltantes y excepciones financieras reales se mantienen como avisos. Las comisiones calculadas y su IVA se reutilizan en reportes e Impuestos y costos sin recaptura; el IVA sigue pendiente de comprobación hasta registrar respaldo fiscal válido. Las liquidaciones históricas no se alteran. Esta decisión sustituye el flujo anterior que combinaba conciliación de cada venta y depósito a Banco.

## Registro informativo de números de serie

Por solicitud del propietario, incluir un módulo privado en Operación para registrar equipo como texto, número de serie único, nombre de cliente, teléfono, correo y fecha. Permitir alta, búsqueda y edición auditada. Rechazar series duplicadas ignorando mayúsculas y espacios exteriores. Mostrar todo el historial, independiente del mes de consulta financiero. Este registro no genera movimientos financieros ni existencias y no requiere la apertura financiera.

**Garantías (regla actualizada):** registrar tres fechas independientes: llegada a tienda (`date`), venta (`sale_date`) y facturación al cliente (`invoice_date`). Si se va a facturar, la garantía inicia en la fecha de la factura que emite el propietario al cliente. No inferir esa fecha de la llegada o venta. Como excepción explícita, permitir marcar **No se va a facturar**: la garantía inicia entonces en la fecha de venta, sin inventar fecha de factura. Mostrar esa decisión por separado del estado Pendiente de facturar. La opción se puede definir al registrar, editar o asignar, se conserva en actualizaciones que la omitan y queda auditada. Impedir combinar No se va a facturar con una fecha de factura existente. Los registros anteriores conservan por defecto la opción de facturar. Permitir registrar la impresora sin cliente, asignar después cliente y fecha de venta y registrar la factura posteriormente con un formulario corto. Incluir folio de factura opcional (hasta 120 caracteres), editable y visible en la lista; solo puede guardarse junto a una fecha de factura y sus cambios quedan auditados. Mientras se vaya a facturar y no haya factura, mostrar Pendiente de facturar sin vencimiento. Si No se va a facturar, calcular desde venta y mantener los estados normales de vigencia. Mantener duración en meses, cálculo por meses calendario e inclusión del día mostrado de vencimiento, filtros y auditoría. Conservar datos previos y la antigua fecha de asignación como venta, dejando factura pendiente; el antiguo `warranty_start` se retiene solo como historia y no inicia la garantía.

## 5. Integración con Clip

La prioridad es evitar duplicar manualmente la captura de ventas.

**Decisión actualizada: usar el reporte de transacciones CSV/Excel de Clip como fuente principal de ingresos, incluyendo efectivo y tarjeta.** La integración con la API y el módulo Dev se retiraron por decisión del propietario; no se usan credenciales de Clip. Reconocer automáticamente el formato del reporte compartido; interpretar sus fechas en hora de Monterrey. Deduplicar por folio, ID de transacción e ID de pago entre archivos, incluso en periodos solapados; bloquear identificadores contradictorios. No deducir IVA, costos ni comisiones a partir de `Net Amount`. Las devoluciones requieren conciliación con su fecha real. Mantener captura consolidada para datos no disponibles y evitar solapamientos con ingresos ya registrados.

**Cobros e inmutabilidad de importaciones:** antes de confirmar, permitir seleccionar por venta nueva Efectivo, Tarjeta o Transferencia; usar el CSV como valor inicial y exigir selección si no se reconoce. Confirmar venta y cobro juntos en Efectivo, Clip por liquidar o Banco respectivamente. Las canceladas y las ventas de cero no generan dinero. Omitir íntegramente ventas existentes al reimportar, sin actualizar importes, fechas, estado, métodos ni movimientos. Las importaciones históricas quedan intactas, incluso si no tenían cobro. Al conciliar tarjetas con cobro en Clip, transferir el neto a Banco y descontar los cargos retenidos de Clip para liquidar el saldo sin duplicar dinero.

**Perfil fiscal y utilidad mensual (decisión vigente):** RESICO persona física y ventas ordinarias con IVA 16% incluido. El propietario descartó integrar otras actividades de su RFC. Calcular únicamente estimaciones de esta tienda, sin exigir ni incorporar ingresos o IVA externos. Desglosar ventas ordinarias, registrar costo vendido mensual con respaldo externo y comprobar IVA según CFDI y pagos. Mantener ajustes opcionales de retenciones y saldo de IVA propios de esta tienda. Mostrar utilidad operativa, IVA e ISR estimados de la tienda y resultado después de ISR; aclarar que la declaración real del RFC puede variar. Excluir ajustes globales anteriores sin alterar sus datos financieros históricos. Mantener auditoría, protección de cierres e inmutabilidad de reimportaciones.



### 5.1 Investigación técnica

Investigar la documentación oficial y las capacidades disponibles en mi cuenta de Clip.

Determinar qué información puede obtenerse mediante reportes:

- ID de transacción.
- Fecha.
- Importe.
- Estado.
- Método de pago.
- Comisión.
- Devoluciones.
- SKU.
- Producto vendido.
- Cantidad.
- Precio unitario.
- Descuentos.

**No asumir que la API pública de Clip proporciona los productos incluidos en cada transacción.**

Diferenciar claramente entre información de cobros e información de artículos vendidos.

### 5.2 Importación de reportes

Implementar importación de archivos CSV o Excel.

El sistema debe:

- Validar el formato.
- Mostrar vista previa.
- Detectar duplicados.
- Identificar errores.
- Registrar el origen.
- Guardar historial de importaciones.
- Permitir reprocesamiento seguro.
- Evitar duplicar ingresos.
- Mostrar un resumen antes de confirmar.

Permitir rechazar un lote pendiente con motivo opcional, sin exigir apertura ni datos válidos. Conservar fecha y decisión en historial y auditoría. Un lote rechazado no se confirma; uno confirmado no se rechaza para deshacer ingresos. Validar de nuevo el mismo archivo rechazado genera otro lote sin perder el historial y mantiene la deduplicación de transacciones.

### 5.3 Registro manual consolidado

Cuando Clip no permita recuperar el detalle de productos, ofrecer captura semanal o mensual.

Permitir registrar:

- Periodo.
- Categoría.
- Producto o modelo, opcional.
- Unidades vendidas.
- Ventas netas.
- Costo de mercancía vendida.
- Comisiones.
- Devoluciones.

Evitar que los registros consolidados y las transacciones importadas se contabilicen simultáneamente como ingresos adicionales.

El sistema debe identificar qué información proviene de Clip y cuál fue capturada manualmente.

### 5.4 Integración mediante archivos

Usar reportes CSV/Excel de Clip para efectivo y tarjeta, con validación, vista previa, deduplicación por identificadores y confirmación transaccional. No desarrollar ni configurar llamadas a la API de Clip. La limpieza del historial no elimina los ingresos confirmados ni sus identificadores.

## 6. Gestión de compras de mercancía

Crear un módulo para registrar adquisiciones de productos destinados a reventa.

Campos sugeridos:

- ID de compra.
- Fecha.
- Proveedor.
- Número de factura o referencia.
- Producto.
- SKU.
- Cantidad.
- Costo unitario.
- Descuentos.
- IVA.
- Flete.
- Otros costos de adquisición.
- Costo total.
- Estado de pago.
- Observaciones.

Permitir compras con múltiples productos.

El sistema debe calcular el costo unitario real de adquisición, distribuyendo los costos adicionales cuando corresponda.

Separar el IVA acreditable del costo de adquisición cuando sea aplicable.

Registrar compras no significa registrar inmediatamente un gasto operativo.

Las compras de mercancía deben incrementar el valor financiero del inventario.

## 7. Catálogo financiero de productos

Crear un catálogo complementario al de Clip, sin intentar sustituirlo.

Campos:

- ID interno.
- SKU.
- SKU o identificador de Clip, cuando exista.
- Nombre.
- Marca.
- Categoría.
- Modelo o variante.
- Costo de adquisición.
- Precio de venta de referencia.
- Margen esperado.
- Estado activo/inactivo.

Categorías iniciales:

- Impresoras 3D.
- Filamentos.
- Accesorios.
- Refacciones.
- Consumibles.
- Otros.

Permitir subcategorías y variantes.

Ejemplos:

Impresoras → Bambu Lab → P2S Combo.

Filamentos → PLA → Marca → Color.

Evitar una estructura rígida que impida agregar nuevas marcas o categorías.

## 8. Inventario financiero

Clip seguirá siendo la fuente de verdad de las existencias operativas.

El nuevo sistema debe permitir conocer el valor económico del inventario.

Indicadores:

- Costo total de inventario.
- Unidades registradas.
- Costo promedio.
- Mercancía adquirida.
- Mercancía vendida.
- Valor de inventario final.
- Rotación.
- Antigüedad de inventario.

Definir una metodología consistente de valuación, preferentemente costo promedio ponderado si es adecuada para los datos disponibles.

No asumir que las existencias financieras son correctas si no se cuenta con movimientos de venta detallados.

Cuando solo existan ventas consolidadas, permitir ajustes documentados de inventario y conciliación periódica contra Clip.

El sistema debe mostrar diferencias entre inventario financiero y operativo cuando exista información suficiente para compararlos.

## 9. Gestión de gastos operativos

Crear un módulo para registrar gastos exclusivos de la tienda.

Categorías sugeridas:

- Renta.
- Electricidad.
- Internet.
- Publicidad.
- Comisiones bancarias.
- Comisiones de Clip.
- Empaques.
- Bolsas y etiquetas.
- Mantenimiento del local.
- Limpieza.
- Transporte.
- Software y suscripciones.
- Sueldos.
- Servicios profesionales.
- Otros gastos.

Campos:

- Fecha.
- Categoría.
- Concepto.
- Proveedor.
- Importe.
- IVA.
- Método de pago.
- Estado de pago.
- Recurrencia.
- Comprobante opcional.
- Observaciones.

Diferenciar gastos operativos, compras de mercancía, activos y movimientos de efectivo.

Permitir gastos recurrentes y filtros por categoría.

## 10. Métodos de pago y comisiones

El negocio acepta diferentes métodos de pago, por ejemplo:

- Efectivo.
- Transferencia SPEI.
- Tarjeta de débito.
- Tarjeta de crédito.
- Meses sin intereses, cuando aplique.

El sistema debe permitir configurar comisiones por método de pago.

Ejemplo:

- Porcentaje de comisión.
- Comisión fija.
- IVA sobre comisión, cuando corresponda.
- Costo adicional de promociones MSI.

**Decisión vigente:** usar una tarifa predeterminada común para todas las tarjetas, débito y crédito, sin aplicarla a efectivo ni transferencias. La regla `Tarjeta` tiene prioridad; si solo existe una tarifa de Crédito o Débito (o ambas tienen los mismos valores), reutilizarla para ambas. Si las tarifas antiguas son distintas y no hay regla común, solicitar configurar `Tarjeta`, sin elegir arbitrariamente.

Calcular la comisión estimada como porcentaje del total cobrado más cargo fijo, redondeado al centavo, más su IVA redondeado al centavo. Mostrarla en ingresos importados pendientes, incluidos los existentes, sin alterar los datos originales ni marcarla como comisión real. Precargar procesamiento, IVA y depósito neto propuesto al conciliar; permitir corregir importes antes de confirmar. Los cargos adicionales por financiamiento requieren revisión separada. No crear depósitos ni gastos al consultar las estimaciones. La liquidación real confirmada tiene prioridad y no se recalcula al cambiar tarifas; el IVA requiere comprobación fiscal antes de acreditarse.

**Descuento de la tarifa en Clip:** al importar una venta con tarjeta y tarifa configurada, conservar el cobro bruto y agregar una salida independiente por comisión con IVA en Clip. Guardar la tarifa aplicada como snapshot inmutable; las reimportaciones y los cambios posteriores de configuración no vuelven a descontarla. Para ventas previas con cobro original permitir una aplicación explícita, auditada y sujeta a cierres, sin modificar venta ni cobro. Al conciliar el depósito real a Banco, ajustar únicamente la diferencia entre comisión aplicada y cargos reales totales, con signo positivo o negativo, para no duplicar cargos y dejar Clip liquidado. Mantener el IVA pendiente de comprobación fiscal y no crear un gasto manual adicional.

**MSI por plazo:** leer `Installment Type = MSI` y el número `Installment` del CSV, incluso cuando `Deferral Comission` sea cero. Las reglas MSI se configuran por plazo exacto (3, 6, 9, 12 u otro entre 2 y 120 meses), con porcentaje base, cargo fijo, IVA y recargo MSI propios. El propietario confirmó que su regla MSI de recargo 4.57% corresponde a 3 meses. No usar esa regla en otros plazos ni adivinar tarifas faltantes. El procesamiento se calcula como porcentaje base del total cobrado más cargo fijo, con su IVA; el financiamiento MSI es el porcentaje adicional del mismo cobro, con su IVA, redondeados por componente al centavo. Registrar los cargos como salidas separadas de Clip con snapshots inmutables. En ventas previas que ya tenían el procesamiento descontado agregar únicamente el cargo MSI pendiente, sin modificar la venta, el cobro ni la comisión base. Mostrar y alertar plazos sin tarifa. Conciliar transfiriendo el neto y ajustando únicamente diferencias con el total real retenido. Un financiamiento que no esté identificado como MSI requiere revisión manual.

Priorizar el importe real cobrado por Clip cuando esté disponible.

Evitar registrar dos veces las comisiones: una desde la transacción y otra como gasto manual.

Permitir analizar el impacto de los métodos de pago en el margen de contribución.

## Cancelaciones de compras y gastos

Permitir cancelar documentos con motivo obligatorio y auditoría, conservando su historial. Excluir gastos y compras cancelados de los cálculos aplicables. En compras por producto, anular el efecto de la entrada y revaluar movimientos posteriores; bloquear y revertir si queda stock insuficiente. Respetar cierres desde la fecha original. No eliminar pagos reales ni crear reembolsos automáticos: registrar recuperaciones parciales o totales de dinero recibido, vinculadas al documento cancelado y limitadas a lo efectivamente pagado pendiente. Mostrar saldo por recuperar e impedir pagos adicionales a documentos cancelados.

## 11. Modelo de rentabilidad

### 11.1 Utilidad bruta

Ventas netas sin IVA

− Costo de mercancía vendida

= Utilidad bruta

### 11.2 Margen de contribución

Utilidad bruta

− Comisiones de cobro

− Otros costos variables de venta

= Margen de contribución

### 11.3 Resultado operativo

Margen de contribución

− Gastos operativos fijos

− Otros gastos operativos aplicables

= Resultado operativo

Evitar duplicar gastos o comisiones.

### 11.4 Flujo de efectivo

Calcular separadamente:

Cobros efectivamente recibidos

− Pagos a proveedores

− Gastos pagados

− Otras salidas de efectivo

= Flujo neto de efectivo del periodo

No confundir flujo de efectivo con utilidad.

Los depósitos de Clip deben conciliarse con los cobros, sin registrarse como nuevas ventas.

## 12. Dashboard principal

Crear un dashboard financiero moderno, limpio y responsive.

### Indicadores superiores

- Ventas netas.
- Utilidad bruta.
- Margen bruto.
- Margen de contribución.
- Resultado operativo.
- Margen operativo.
- Flujo neto de efectivo.
- Valor de inventario.

### Gráficas

- Ventas por mes.
- Utilidad por mes.
- Ingresos contra costos.
- Gastos por categoría.
- Ventas por categoría.
- Margen por categoría.
- Evolución del inventario.
- Distribución de métodos de pago.

### Tablas

- Productos más vendidos.
- Productos más rentables.
- Compras recientes.
- Gastos recientes.
- Importaciones de Clip.
- Productos con baja rotación.

Mostrar únicamente métricas respaldadas por información suficiente.

Si faltan costos o detalle de artículos, indicar que el cálculo es parcial o no está disponible.

No inventar rentabilidad por SKU a partir de transacciones que únicamente contienen importes totales.

## 13. Filtros y análisis histórico

Permitir consultar información por:

- Día.
- Semana.
- Mes.
- Trimestre.
- Año.
- Rango personalizado.
- Categoría.
- Producto.
- Proveedor.
- Método de pago.

Incluir comparaciones contra el periodo anterior y tendencias históricas.

Evitar comparaciones engañosas entre periodos de distinta duración.

## 14. Cierre mensual

Implementar un proceso sencillo para revisar el resultado de cada mes.

Verificaciones:

1. Ventas registradas o importadas.
2. Devoluciones y cancelaciones.
3. Comisiones.
4. Compras de mercancía.
5. Costo de mercancía vendida.
6. Inventario final.
7. Gastos operativos.
8. Pagos pendientes.
9. Cobros y depósitos conciliados.
10. Diferencias detectadas.

Generar un resumen financiero mensual.

Permitir ajustes posteriores con registro de auditoría.

## 15. Exportación a Excel

Esta funcionalidad es especialmente importante.

Necesito exportar los resultados de la tienda para consolidarlos manualmente con otra actividad empresarial en Excel.

Implementar exportación en XLSX o CSV de:

- Estado de resultados mensual.
- Ventas por categoría.
- Compras.
- Gastos.
- Costos.
- Flujo de efectivo.
- Valor de inventario.
- Indicadores principales.

El reporte mensual debe incluir una estructura consistente, con columnas como:

| Periodo | Concepto | Importe MXN |
|---|---|---|
| 2026-11 | Ventas netas | Valor |
| 2026-11 | Costo de mercancía vendida | Valor |
| 2026-11 | Utilidad bruta | Valor |
| 2026-11 | Comisiones | Valor |
| 2026-11 | Gastos operativos | Valor |
| 2026-11 | Resultado operativo | Valor |
| 2026-11 | Flujo neto de efectivo | Valor |
| 2026-11 | Inventario final | Valor |

Usar nombres de columnas estables para facilitar la consolidación en Excel.

No desarrollar la consolidación con otras actividades dentro de este sistema.

## 16. Experiencia de usuario

Priorizar una experiencia sencilla para una operación comercial pequeña.

Requisitos:

- Dashboard claro.
- Navegación intuitiva.
- Captura rápida de gastos.
- Registro de compras con múltiples productos.
- Importación de archivos.
- Tablas con búsqueda y filtros.
- Gráficas útiles.
- Diseño responsive.
- Exportación de reportes.
- Validaciones.
- Mensajes de error comprensibles.

Evitar complejidad administrativa innecesaria.

## 17. Requisitos técnicos

Antes de desarrollar, inspeccionar el proyecto y determinar su arquitectura.

Respetar:

- Frameworks existentes.
- Convenciones de código.
- Estructura de carpetas.
- Sistema de autenticación, si existe.
- Base de datos.
- Componentes reutilizables.
- Manejo de errores.
- Estrategia de migraciones.

Para importes monetarios utilizar tipos decimales apropiados y cálculos consistentes.

Implementar restricciones para evitar registros duplicados, especialmente en importaciones.

No incorporar microservicios, multi-tenancy o infraestructura compleja sin una necesidad demostrable.

## 18. Fases de desarrollo

### Fase 1 — Análisis y diseño

- Revisar arquitectura.
- Definir modelo de datos.
- Diseñar módulos.
- Definir estrategia de Clip.
- Proponer navegación.
- Establecer fórmulas financieras.

### Fase 2 — MVP financiero

- Importación de reportes CSV/Excel de Clip con efectivo, tarjeta y deduplicación.

- Catálogo de productos.
- Proveedores.
- Compras.
- Gastos.
- Ventas consolidadas.
- Cálculo básico de rentabilidad.
- Dashboard inicial.

### Fase 3 — Inventario y análisis

- Valuación de inventario.
- Costos por producto.
- Rentabilidad por categoría.
- Rotación.
- Comparativas históricas.

### Fase 4 — Importaciones

- CSV/Excel.
- Validación.
- Conciliación.
- Historial.
- Detección de duplicados.

### Fase 5 — Reportes

- Cierre mensual.
- Exportación a Excel.
- Estado de resultados.
- Flujo de efectivo.

### Fase 6 — Automatización opcional

- Mejoras a la importación de reportes CSV/Excel.
- Alertas.
- Reportes automatizados.

## 19. Entregables iniciales

Antes de comenzar a escribir código, entregar:

1. Diagnóstico técnico del proyecto.
2. Arquitectura propuesta.
3. Modelo entidad-relación.
4. Definición de tablas.
5. Relación de módulos y pantallas.
6. Flujo de información con Clip.
7. Estrategia para registrar ventas sin duplicarlas.
8. Definición de cálculos financieros.
9. Diseño del dashboard.
10. Plan de desarrollo por fases.

Identificar los supuestos y las decisiones que requieren confirmación.

**No comenzar a modificar el código hasta recibir aprobación del diseño.**

## 20. Principios fundamentales

- Clip administra las ventas y el inventario operativo.
- El nuevo sistema administra costos, compras, gastos y rentabilidad.
- No duplicar funciones de punto de venta.
- No registrar manualmente cada transacción si existe una alternativa de importación.
- No confundir compras de inventario con gastos operativos.
- No confundir utilidad con flujo de efectivo.
- No calcular márgenes sin costos confiables.
- No duplicar comisiones ni ingresos.
- No desarrollar funcionalidades de producción.
- No desarrollar consolidación entre negocios.
- Permitir exportar resultados a Excel.
- Priorizar simplicidad, confiabilidad y mantenimiento.

**Resultado esperado:** una aplicación ligera de inteligencia financiera comercial que permita conocer con precisión cuánto vende la tienda, cuánto cuesta operar, cuánto capital mantiene en mercancía y cuánto dinero genera realmente.


**Respaldos web (2026-11-24):** Configuración incluye descarga privada de toda la base en ZIP sin filtro de periodo. En PostgreSQL se usa MIGRATION_DATABASE_URL con pg_dump custom completo y pg_dumpall --roles-only --no-role-passwords; validar catálogo con pg_restore --list y agregar hashes e instrucciones. Herramientas nativas detectadas por PATH/PG_DUMP_PATH/Homebrew libpq; no requiere Docker ni plan pagado. PGlite exporta dumpDataDir restaurable con loadDataDir. No incluir .env ni claves; Storage y configuración externa requieren respaldo aparte. No hay restauración automática sobre producción. Bloquear descargas concurrentes por proceso, no entregar copias parciales y borrar temporales privados; el evento de generación queda auditado. Ver README para requisitos y límites.
