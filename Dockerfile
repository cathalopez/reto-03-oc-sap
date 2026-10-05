# Imagen oficial de Bun
FROM oven/bun:1

WORKDIR /app

# Instala dependencias con el lockfile (reproducible)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copia el resto del proyecto
COPY . .

ENV NODE_ENV=production
# El proveedor de despliegue inyecta el puerto en la variable PORT
EXPOSE 3000

CMD ["bun", "run", "src/server.ts"]
