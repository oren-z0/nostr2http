FROM node:20.12.2-bookworm-slim
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build
RUN npm prune --production
RUN chown -R node:node .
USER node
ENTRYPOINT ["npm", "start", "--"]
