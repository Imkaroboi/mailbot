FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate && pnpm install --prod --frozen-lockfile --ignore-scripts
COPY auth.mjs http.mjs reader.mjs server.mjs ./
USER node
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
