# 3dprintmty Tienda

Sistema de control financiero comercial para una tienda de productos de impresión 3D. Clip conserva el POS y el inventario operativo. Tienda registra adquisiciones, costos, gastos, ingresos y flujo de efectivo; exporta los resultados para consolidarlos externamente en Excel.

## Arranque local

Requisitos: Node.js 22+ y npm.

```sh
npm ci
cp .env.example .env
npm run dev
```

- Aplicación: http://127.0.0.1:5173
- Salud de la API y su conexión: http://127.0.0.1:3001/api/v1/health
- En modo local, pulsa **Abrir entorno local**. Solo funciona con conexión desde loopback, `AUTH_DRIVER=local`, fuera de producción y sin `DATABASE_URL`.
- Datos persistentes en `.data/pglite`. Las pruebas usan una base independiente en memoria, sin alterar la operación local.

El `.env` de esta instalación ya tiene la URL de Supabase y su clave publicable. No se guardó la clave secreta proporcionada en el chat: la verificación de identidad utiliza JWKS y no la necesita. `.env` está excluido de Git.

## Primer uso

1. Agrega proveedores. Desde **Proveedores → Ver / editar** puedes actualizar nombre, correo y referencia fiscal; las compras conservan su vínculo con el mismo proveedor y los cambios quedan auditados. El inventario y el catálogo se administran fuera de esta aplicación.
2. En **Configuración**, registra la fecha de apertura y los saldos de efectivo, banco y Clip. No se solicitan productos, existencias ni valor inicial de inventario.
3. En **Compras**, registra el importe de mercancía sin seleccionar productos. El flete y los impuestos no recuperables aumentan su costo; el IVA acreditable se guarda aparte. Las compras aumentan mercancía adquirida y no se restan como gasto al registrar la compra.
4. En **Datos de Clip**, carga el reporte CSV/XLSX de Clip, revisa las transacciones nuevas/existentes y selecciona el tipo de pago de cada venta nueva antes de confirmar. El valor inicial viene del CSV; puedes corregirlo a efectivo, tarjeta o transferencia. Al confirmar, se registra un cobro en Efectivo, Clip por liquidar o Banco respectivamente. Las ventas existentes se omiten por completo y no se vuelven a cobrar. Incluye efectivo y tarjeta. Los estatus distintos de `approved` requieren elegir si se incluyen o excluyen antes de previsualizar; los cancelados incluidos conservan su estado y no suman ingresos. Excluir no elimina registros existentes.
5. Completa IVA, costo vendido y comisión real en **Ingresos** cuando tengas respaldo. Un campo vacío es desconocido; cero confirma ausencia de costo o comisión.
6. Registra gastos devengados. En compras y gastos, **Registrar como pagado** permite capturar el pago total en Efectivo o Banco junto con el documento. La fecha de pago es opcional: si se omite, se usa la del documento. Ambos se guardan en una sola transacción y los reintentos no duplican la salida. Desde **Gastos o Compras → Ver / editar** también puedes registrar pagos totales o parciales directamente, eligiendo fecha y cuenta. Se muestra el saldo pendiente y el pago queda vinculado al documento correcto. Los cobros efectivos y otros movimientos se capturan en **Efectivo**.
7. Mantén el inventario en tu herramienta externa. Aquí puedes documentar el costo de lo vendido cuando dispongas de respaldo. Si falta ese costo, la utilidad queda pendiente; el importe de las compras no se resta automáticamente como costo vendido.
8. Revisa reportes, exporta XLSX/CSV y completa el cierre mensual. Los meses cerrados bloquean cambios que alteren sus resultados; reabrir exige motivo.

**Devoluciones:** abre un ingreso activo para registrar importe, base sin IVA, costo devuelto documentado. La venta original se conserva; la devolución se reconoce en su fecha. El reembolso efectivo se registra aparte.

**Recurrencias:** marca un gasto como plantilla mensual. Desde Configuración puedes generar el gasto de cada mes; la misma plantilla no se genera dos veces en un mes. Generar no equivale a pagar.

## Reportes de Clip

La integración utiliza únicamente archivos CSV/XLSX del panel de Clip. La API de Clip y el módulo Dev se retiraron; no se necesitan credenciales ni variables `CLIP_*` en `.env`.

Reimportar una transacción actualiza su registro sin sumar otra venta. Los periodos/canales con ingresos consolidados requieren retirar y conciliar esa cobertura antes de activar transacciones individuales.

### CSV y XLSX

El reporte de transacciones de Clip se reconoce automáticamente por sus encabezados (`Date`, `Transaction ID`, `Payment ID`, `Receipt No`, `Payment Status`, `Payment Currency`, `Paid Amount`, `Payment Method Type`). Sus fechas se leen en hora de Monterrey. Se usa `Paid Amount` como cobro y se conserva el método efectivo/tarjeta. `Net Amount` no se interpreta como venta sin IVA y no se deducen costos ni comisiones. Las filas con devoluciones, moneda distinta de MXN o estados sin conciliar bloquean la confirmación para revisión.

Los folios y los IDs de transacción/pago reconocen operaciones ya cargadas, incluso entre archivos renombrados y periodos solapados. Las coincidencias se omiten y conservan íntegros el ingreso y sus movimientos; los identificadores contradictorios bloquean el lote. Filas idénticas repetidas dentro de un reporte se consolidan; ventas diferentes con el mismo importe se conservan. Las restricciones únicas de PostgreSQL y la confirmación transaccional protegen también ante cargas concurrentes. Los reportes posteriores no eliminan operaciones ausentes.

Para archivos de otro formato se mantiene el mapeo manual. Se aceptan archivos con encabezados únicos, hasta 3 MB, 10,000 filas y 80 columnas; se leen valores, no fórmulas. Se seleccionan las columnas del archivo en pantalla. Fechas ISO `YYYY-MM-DD`; importes sin separadores de miles, símbolos ni más de dos decimales. Se exige un identificador estable; filas sin ID o duplicadas dentro del lote producen errores. Se conserva el contenido normalizado, sus errores, hash y origen. Esta versión no conserva el binario original del archivo.

Estados compatibles: `active`, `paid`, `approved`, `pagado`, `cancelled`, `cancelado`. Las devoluciones se registran con su flujo específico, no reinterpretando importes negativos. Confirma expresamente en la importación si un reporte sin estado contiene únicamente cobros pagados.

En la vista previa puedes **Rechazar lote**, con motivo opcional, incluso si hay errores o falta la apertura. El lote queda como rechazado en el historial, con fecha y auditoría; no crea ni elimina ingresos. No se puede confirmar un lote rechazado ni rechazar uno ya confirmado. Validar otra vez el mismo archivo rechazado crea una vista previa nueva, conservando la decisión anterior y la deduplicación de transacciones.

## Supabase y producción

Proyecto previsto: `bokjsjmwvyoxbduxyoth`. Propietario autorizado: `mdeleon@3dprintmty.com`.

Para activar un entorno real se necesita una conexión PostgreSQL. Las claves HTTP de Supabase no sustituyen la contraseña de PostgreSQL.

1. Deshabilita los registros públicos en Supabase Auth y aprovisiona explícitamente la cuenta del propietario; no existe registro público ni alta del primer visitante como dueño.
2. Configura `AUTH_DRIVER=supabase`, `OWNER_EMAIL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `DATABASE_URL`, `MIGRATION_DATABASE_URL` y `CORS_ORIGIN`.
3. Usa credenciales distintas para migración y runtime. La migración inicial requiere un esquema `public` vacío: se detiene si detecta tablas existentes. No reutilices la base del ERP.
4. Con la credencial de DDL ejecuta `npm run db:migrate`. El migrador usa una conexión dedicada, lock y checksums. El arranque PostgreSQL solo verifica el esquema, sin DDL.
5. El administrador de la base debe conceder al usuario de conexión de runtime pertenencia a `tienda_api` y permisos para establecer ese rol. No concedas `tienda_api` a `anon`, `authenticated` ni `authenticator`. Runtime sin DDL ni BYPASSRLS.
6. Configura Auth con JWT asimétricos compatibles con JWKS. El guard valida firma, issuer, audience y el correo del propietario en cada petición. Las tablas de negocio no están disponibles directamente mediante la Data API.

El proceso HTTP se mantiene ligado a `127.0.0.1`; esta entrega es local, sin publicación ni exposición de red. Para publicar, primero hay que definir y autorizar la infraestructura de la API y su proxy. La configuración de Vercel prepara el frontend desde la raíz con `API_ORIGIN` HTTPS, proxy `/api/*` sin caché y fallback de rutas React.

## Arquitectura y verificación

Monorepo npm workspaces inspirado en las herramientas del ERP:

- `apps/web`: React 19, Vite, Tailwind 4, React Router, TanStack Query, i18next y Supabase JS.
- `apps/api`: NestJS, Express, tsx, Zod, jose, pg y Drizzle.
- `packages/domain`: cálculos puros con decimal.js; centavos `bigint` e importes/cantidades serializados como cadenas.
- `packages/shared`: contratos y errores.
- `supabase/migrations`: SQL nuevo, sin entidades ni migraciones de producción del ERP.
- ExcelJS: importación/exportación XLSX y lectura CSV; lucide-react: iconos; Prettier: formato.

```sh
npm run typecheck
npm test
npm run build
npm run format:check
```

Las pruebas cubren dinero, prorrateo, promedio ponderado, rollback, stock insuficiente, pagos parciales, fuentes excluyentes, deduplicación, IVA desconocido, devoluciones, conciliación, cierres, permisos e importación de archivos de Clip. PostgreSQL remoto y revisión visual de navegador requieren verificación posterior en el ambiente efectivo.

## Criterios financieros

- Utilidad: ventas netas sin IVA − costo vendido − comisiones reales sin IVA − gastos operativos devengados.
- Efectivo disponible: movimientos efectivos en caja/banco; apertura y aportes/retiros se presentan aparte. Transferencias entre cuentas disponibles se cancelan; la liquidación desde Clip pendiente hace disponible el cobro en banco sin otra venta.
- Las existencias se administran fuera del sistema. El costo vendido se documenta de forma independiente de compras y pagos.
- Datos desconocidos son nulos. Un consolidado que cruza el rango se excluye y se marca cobertura parcial en vez de prorratearlo.
- Los movimientos retroactivos recalculan costos posteriores dentro de periodos abiertos e invalidan la conciliación afectada.
- No hay POS, procesamiento de pagos, fabricación, multi-tenancy ni consolidación con otros negocios.

El [diseño inicial](docs/diseno-inicial.md) conserva el alcance completo y las decisiones de referencia. Los filtros analíticos adicionales, la automatización programada y el despliegue se completan sobre esta base a medida que estén disponibles sus datos y destinos.


## Cancelación de compras y gastos

Abre **Ver / editar** en Compras o Gastos y captura el motivo en **Cancelar compra / Cancelar gasto**. El documento se conserva con estado cancelado, fecha y auditoría. Los gastos cancelados se excluyen del resultado y las compras canceladas quedan identificadas para conciliación. Puedes registrar una factura corregida con la misma referencia y proveedor después de cancelar la anterior.

La cancelación es una corrección del documento original y respeta los meses cerrados. Los datos históricos se conservan para trazabilidad.

Los pagos efectivos se conservan. Cuando recibas un reembolso, usa **Efectivo → Recuperación de compra / gasto cancelado**, selecciona el documento, la cuenta y la fecha real. Se permiten recuperaciones parciales hasta el importe pagado pendiente a esa fecha; no crean ventas ni modifican nuevamente el resultado. La recuperación pendiente se muestra en el detalle y genera advertencia de conciliación en el reporte. Los documentos cancelados no admiten pagos adicionales. Cancelar una instancia recurrente no elimina su plantilla ni genera otra instancia automáticamente para el mismo periodo.

## Sin módulos de productos e inventario

Productos e Inventario se retiraron del menú, las rutas, formularios, indicadores y exportaciones. La apertura solicita solo saldos monetarios y las compras se registran por importe. No se crean existencias ni se requieren conciliaciones o cortes de inventario para operar.

Los datos históricos anteriores se conservan en la base para trazabilidad. El modo vigente es `external`; el costo vendido se documenta con información externa y permanece pendiente si no se conoce. Esto impide confundir compras con mercancía efectivamente vendida. Las validaciones de IVA, comisiones y costos siguen señalando las limitaciones de los reportes financieros.

Los gastos permiten captura por **Total sin IVA acreditable** (un solo importe, incluidos impuestos no recuperables) o por importe e IVA acreditable separados. La modalidad se conserva en las plantillas recurrentes. No se infiere IVA, exención ni deducibilidad fiscal.

### Conciliación de cobros Clip

El importador conserva `Base Amount`, `Tip Amount`, `Deferral Comission`, `Net Amount`, `Paid Amount` y los datos del plan de pago, sin confundirlos con ventas sin IVA ni con una comisión ordinaria. Si base + propina + diferimiento no cuadra con lo cobrado, bloquea la fila para revisión.

En **Ingresos → transacción → Conciliar depósito**, confirma la comisión de procesamiento y el financiamiento realmente retenidos (ambos con IVA incluido), el IVA de esos cargos, la fecha y el importe neto depositado, y la referencia del estado de cuenta. Si un depósito agrupa ventas, asigna importes por transacción con el detalle de liquidación.

La tarifa común **Tarjeta (débito y crédito)** precarga la comisión de procesamiento y su IVA: `(total cobrado × porcentaje + cargo fijo) + IVA sobre la comisión`, con redondeo al centavo de base e IVA. Si solo hay una tarifa previa de Crédito o Débito, también se usa para ambas; las tarifas distintas requieren definir la común. Ingresos muestra el cargo como **Estimada**, incluso en ventas ya importadas pendientes de liquidar. El depósito neto se propone cuando no hay financiamiento adicional; se puede corregir todo antes de confirmar. Consultar una estimación no modifica ventas ni genera movimientos. Las liquidaciones conciliadas conservan sus importes reales aunque cambie la tarifa. El IVA propuesto no se acredita sin comprobación fiscal en Impuestos y costos.

Al confirmar nuevas ventas con tarjeta, la importación conserva el cobro bruto en Clip y registra una salida separada por la comisión configurada con IVA. El saldo de Clip queda neto de esa comisión, sin generar aún un depósito en Banco. La tarifa aplicada queda congelada y vinculada a la venta; cambiar la configuración o reimportar no vuelve a descontarla. Una venta anterior con cobro original y sin comisión aplicada ofrece **Aplicar comisión a Clip** en su detalle, con auditoría y protección de cierres. Las ventas y cobros originales permanecen intactos. Ingresos identifica el cargo como **Aplicada en Clip**; su importe real sigue pendiente de conciliación.

Al conciliar, el sistema transfiere el depósito real a Banco y registra solamente la diferencia entre el cargo aplicado y el cargo real total, incluido financiamiento. Un exceso de comisión aplicada regresa a Clip mediante un ajuste positivo; un faltante genera un ajuste negativo. La cuenta queda liquidada sin descontar dos veces la comisión. No registres estos cargos adicionalmente como gasto manual.

**MSI:** en Configuración → Reglas de comisión, selecciona MSI y su plazo (3, 6, 9, 12 u otro). Cada plazo conserva su propio porcentaje base, cargo fijo, IVA y recargo MSI; puedes editar su fila sin sustituir las demás. El importador reconoce `Installment Type = MSI` y `Installment`, aunque el reporte indique diferimiento cero. Además del procesamiento, descuenta de Clip el recargo del plazo configurado y su IVA. El cargo fijo se cobra una sola vez. Si falta una tarifa exacta, muestra un pendiente y no usa la de otro plazo. Las ventas anteriores con comisión base aplicada admiten agregar solo el cargo MSI que falta, sin duplicar cargos. La conciliación precarga ambos componentes y el depósito neto; confirma siempre los importes reales. El IVA sigue sujeto a comprobación fiscal. Financiamientos distintos de MSI no toman automáticamente estas tarifas.

La conciliación exige `cobro = depósito + procesamiento + financiamiento` al centavo. Para los nuevos cobros registrados en Clip, transfiere el neto a Banco y descuenta de Clip los cargos retenidos, dejando liquidado ese cobro. Para registros históricos sin cobro automático, conserva la conciliación previa: registra una sola entrada en Banco, o reutiliza la entrada existente si coincide exactamente en cuenta, fecha e importe. Si hay movimientos previos incompatibles o devoluciones, bloquea la conciliación para revisión. Los cargos menos su IVA recuperable se reconocen una sola vez como comisiones en la utilidad; no deben capturarse también como gasto.

Una transacción conciliada conserva su depósito y comisiones al reimportarse; los datos distintos del CSV se omiten para esa venta. El cierre mensual exige resolver las conciliaciones de Clip pendientes. La comisión y la utilidad completa siguen pendientes mientras falte esa verificación. Los registros históricos y sus movimientos se conservan íntegramente al reimportar. Los cobros históricos faltantes se revisan por separado; una reimportación no los crea ni modifica sus métodos de pago.

### Tipos de pago e inmutabilidad de importaciones

El tipo de pago de cada venta nueva se elige en la vista previa y se guarda al confirmar. Los métodos desconocidos exigen selección explícita. Las canceladas y las ventas de importe cero no crean dinero. La creación de ventas y cobros es atómica, y las confirmaciones simultáneas de archivos solapados conservan una sola venta y un solo cobro por identificador. Las transacciones existentes se reconocen por ID de transacción, pago o folio; se omiten aun si el nuevo CSV cambia fecha, importe, método o estado. El tipo elegido en la primera importación prevalece. Los complementos documentados y las devoluciones siguen teniendo sus flujos explícitos y auditados.

### Utilidad mensual y RESICO persona física

**Impuestos y costos** reutiliza directamente las compras, gastos, activos, pagos e IVA existentes, sin volver a capturarlos ni crear documentos duplicados. Muestra los totales del periodo, pagos realizados e IVA pagado pendiente de comprobación. Los gastos registrados como total sin IVA recuperable conservan automáticamente ese tratamiento. Si una referencia existente es un UUID válido, se propone al comprobar el CFDI; el acreditamiento todavía requiere confirmación y respaldo. El dashboard prioriza cobros, pagos y flujo de caja cuando se administra sin inventario.

El dashboard no requiere costo vendido ni muestra utilidad o márgenes pendientes. Presenta cobros, compras pagadas, gastos/activos pagados, flujo mensual y su composición, junto con estimaciones fiscales de la tienda. Los cobros en Clip se distinguen del dinero disponible hasta su liquidación. El flujo de Efectivo/Banco excluye apertura, aportaciones y retiros; las transferencias entre estas cuentas se compensan. La exportación del dashboard sigue este alcance financiero. Las alertas de esta vista se limitan a conciliación, apertura, devoluciones y recuperaciones; la comprobación de impuestos conserva sus propios avisos.

En **Impuestos y costos** se registra el costo de mercancía vendida por mes con respaldo externo, sin catálogo de productos. Se usa una sola cifra: sustituye el costo por venta, no se suma a él. El monto se aplica al mes completo de operación (incluye el primer mes desde la apertura); los rangos parciales no reciben prorrateos arbitrarios. Puede corregirse o retirarse dejando auditoría, siempre que los meses afectados estén abiertos. Si después se registran nuevas ventas o devoluciones en ese mes, se requiere revisar y confirmar de nuevo el costo; no se mantiene una utilidad aparentemente completa con un costo anterior.

No se requiere detalle de productos vendidos ni captura por ticket. Para calcular utilidad contable basta con el costo total mensual del PDV; sin ese dato se puede consultar el flujo de caja. Las compras de mercancía se muestran como adquisiciones y pagos, sin asumir que toda esa mercancía ya se vendió.

El propietario confirmó RESICO persona física y precios ordinarios con IVA del 16% incluido. El perfil calcula venta sin IVA = cobro / 1.16, redondeando al centavo y conservando el total. Nuevas importaciones guardan el desglose; los ingresos existentes se presentan con un cálculo derivado sin modificar sus registros ni movimientos. `Net Amount` de Clip nunca se usa como venta sin IVA. Propinas y diferimiento adicional requieren desglose fiscal documentado. Efectivo y transferencias no generan comisión de Clip; los cargos bancarios distintos se registran como gastos cuando correspondan.

La página fiscal permite confirmar el tratamiento del IVA de compras, gastos y cargos retenidos de Clip: pendiente, acreditable con CFDI o no recuperable. El acreditamiento requiere UUID, IVA total del comprobante, fecha de comprobación y respaldo. Las asignaciones compartidas no pueden superar el IVA del CFDI. Solo se reconoce IVA proporcional al pago efectivo; si se obtiene el respaldo después, se reconoce al comprobarlo. Los importes sin desglose y los no recuperables no se acreditan. El IVA no recuperable de gastos y comisiones se incorpora a su costo, conservando los documentos originales.

Los impuestos se estiman por mes exclusivamente sobre los cobros de esta tienda. No se solicitan ni incorporan ingresos o IVA de otras actividades del RFC. Para RESICO se aplica la tasa correspondiente a los ingresos de la tienda de forma aislada, sin deducir costos ni gastos. Los ajustes opcionales permiten registrar retenciones y saldo anterior de IVA propios de esta operación. El resultado después de ISR usa el impuesto estimado de la tienda antes de retenciones. La declaración real del contribuyente puede variar al integrar sus otras actividades. Los ajustes globales anteriores quedan archivados con alcance `legacy_rfc` y no se aplican ni se presentan en los cálculos de la tienda.

Se muestran IVA cobrado, IVA acreditable, IVA por pagar/a favor, ISR estimado, ISR estimado por pagar y resultado después de ISR, todos limitados a esta tienda. No se compensan automáticamente saldos de IVA entre meses; la captura del saldo anterior evita aplicarlo dos veces. Los datos fiscales faltantes, devoluciones por conciliar, comprobantes pendientes y meses parciales quedan identificados. Las devoluciones requieren revisión fiscal antes de estimar su efecto en impuestos. Los reportes y cierres incorporan el resumen fiscal y conservan protección contra cambios retroactivos.

Fuentes de las reglas: [LISR, artículo 113-E](https://wwwmat.sat.gob.mx/articulo/58780/articulo-113-e), [LISR vigente, Cámara de Diputados](https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf), [LIVA, artículo 5](https://wwwmatnp.sat.gob.mx/articulo/46936/articulo-5). Los indicadores son estimaciones para administración; no generan declaraciones, CFDI ni pagos de impuestos. Las cifras de esta tienda no representan la declaración global del RFC.
