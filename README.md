# Comprá Fácil — Scraper (repo separado, público)

Este repo existe por un solo motivo: correr el scraping automático (precios + promos
bancarias) en GitHub Actions **gratis e ilimitado**. GitHub Actions es gratis sin límite de
minutos en repos **públicos**; en un repo **privado** da sólo 2000 minutos/mes — corriendo el
scraping completo a diario desde ahí, se agotaba el cupo en menos de una semana y bloqueaba
toda la cuenta.

La app en sí (panel admin, algoritmo de carrito, UI) vive en un repo **privado** aparte. Acá
sólo está el código de los adaptadores y los scripts que escriben en la misma base de datos
Postgres (Neon) que usa esa app — no hay nada del panel admin ni de la lógica de negocio.

## Qué hay acá

```
adapters/                 Un archivo por supermercado (precios) y por banco (promos)
scripts/run_adapters.ts           Orquestador de precios
scripts/save_adapter_results.ts   Persiste los resultados de un adaptador
scripts/run_promos_bancarias.ts   Orquestador de promos bancarias
scripts/save_promos_bancarias.ts  Persiste los resultados de un adaptador de promos
src/lib/                  Matching de productos, cliente Prisma, heurísticas compartidas
prisma/schema.prisma      Mismo schema que el repo principal (sólo para generar el cliente)
```

## Mantener esto sincronizado con el repo principal

**Importante:** estos archivos son una copia manual de los mismos archivos en el repo
principal (privado). No hay ningún automatismo que los mantenga sincronizados — si arreglás
un bug en un adaptador o en `src/lib/normalize.ts` en el repo principal, hay que copiar el
archivo actualizado acá también (y viceversa). Si esto se vuelve tedioso, la alternativa es un
`git subtree`, pero por ahora se optó por la copia simple.

## Configuración

1. `cp .env.example .env` y completar `DATABASE_URL` con el mismo connection string de Neon
   que usa el repo principal.
2. `npm install`
3. `npm run scrape:all` / `npm run scrape:promos` para correrlo a mano.

## GitHub Actions

El workflow `.github/workflows/run-adapters.yml` corre todos los días a las 03:00 UTC. Necesita
el secret `DATABASE_URL` cargado en Settings → Secrets and variables → Actions (mismo valor
que en `.env`).
