-- CreateTable
CREATE TABLE "PrecioActual" (
    "id" SERIAL NOT NULL,
    "productoCanonicoId" INTEGER NOT NULL,
    "supermercadoId" INTEGER NOT NULL,
    "precio" DOUBLE PRECISION NOT NULL,
    "precioPromo" DOUBLE PRECISION,
    "precioFinal" DOUBLE PRECISION NOT NULL,
    "promoDescripcion" TEXT,
    "promoDesde" TIMESTAMP(3),
    "promoHasta" TIMESTAMP(3),
    "fechaRelevado" TIMESTAMP(3) NOT NULL,
    "fuente" TEXT,

    CONSTRAINT "PrecioActual_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrecioActual_productoCanonicoId_supermercadoId_key" ON "PrecioActual"("productoCanonicoId", "supermercadoId");

-- CreateIndex
CREATE INDEX "PrecioActual_supermercadoId_fechaRelevado_idx" ON "PrecioActual"("supermercadoId", "fechaRelevado");

-- CreateIndex
CREATE INDEX "PrecioActual_precioFinal_idx" ON "PrecioActual"("precioFinal");

-- AddForeignKey
ALTER TABLE "PrecioActual" ADD CONSTRAINT "PrecioActual_productoCanonicoId_fkey" FOREIGN KEY ("productoCanonicoId") REFERENCES "ProductoCanonico"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrecioActual" ADD CONSTRAINT "PrecioActual_supermercadoId_fkey" FOREIGN KEY ("supermercadoId") REFERENCES "Supermercado"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
-- Precio no tenía ningún índice: cada "último precio de este producto" era un scan de la tabla
-- entera (>1M de filas). Es el índice que necesitan tanto la reconstrucción de PrecioActual como
-- el gráfico de histórico de /products/[id].
CREATE INDEX "Precio_productoCanonicoId_supermercadoId_fechaRelevado_idx" ON "Precio"("productoCanonicoId", "supermercadoId", "fechaRelevado" DESC);
