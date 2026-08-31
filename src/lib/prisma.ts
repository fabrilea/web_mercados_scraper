// Los scripts sueltos (npx ts-node scripts/...) no pasan por el bootstrap de Next, que es
// quien normalmente carga .env — sin esto, DATABASE_URL sólo se toma de una variable de
// entorno del sistema operativo si existe una (ver nota en CLAUDE.md sobre esta confusión).
// `override: true` es a propósito: dotenv por default NO pisa variables ya seteadas en el
// proceso, así que sin esto una variable de entorno vieja a nivel de Windows (o cualquier
// otra) seguiría ganándole silenciosamente a .env — que es justo el bug que causó esto.
import { config } from 'dotenv'
config({ override: true })
import { PrismaClient } from '@prisma/client'

declare global {
	// eslint-disable-next-line no-var
	var __prismaClient: PrismaClient | undefined
}

const prisma = global.__prismaClient || new PrismaClient()
if (process.env.NODE_ENV !== 'production') global.__prismaClient = prisma

export default prisma
