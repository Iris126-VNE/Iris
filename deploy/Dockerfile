FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/hub-server/package.json apps/hub-server/

RUN npm install

COPY packages/protocol packages/protocol
COPY apps/hub-server apps/hub-server

RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/protocol/package.json ./packages/protocol/
COPY --from=builder /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder /app/apps/hub-server/package.json ./apps/hub-server/
COPY --from=builder /app/apps/hub-server/dist ./apps/hub-server/dist
COPY knowledge ./knowledge

ENV PORT=8765
ENV KNOWLEDGE_DIR=/app/knowledge
EXPOSE 8765

CMD ["node", "apps/hub-server/dist/index.js"]
