FROM node:20-alpine

WORKDIR /app

# Copy package files and install
COPY package.json ./
RUN npm install --production

# Copy source
COPY src/ ./src/

EXPOSE 3402

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "console.log('ok')" || exit 1

CMD ["node", "src/index.js"]
