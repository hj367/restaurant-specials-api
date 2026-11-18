# Build stage: compile TypeScript
FROM apify/actor-node:22 AS builder

COPY --chown=myuser:myuser package*.json ./
RUN npm install --include=dev --audit=false

COPY --chown=myuser:myuser . ./
RUN npm run build

# Run stage: production dependencies + compiled JS only
FROM apify/actor-node:22

COPY --chown=myuser:myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional --audit=false \
    && echo "Node.js version:" && node --version \
    && echo "NPM version:" && npm --version \
    && rm -r ~/.npm

COPY --from=builder --chown=myuser:myuser /usr/src/app/dist ./dist
COPY --chown=myuser:myuser . ./

CMD ["npm", "run", "start:prod", "--silent"]
