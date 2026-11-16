# Sentinel - Node.js Alpine Docker Image
FROM node:20-alpine

ENV NODE_ENV=production

# Set working directory
WORKDIR /app

# Install dependencies first (better caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application files
COPY . .

# Prepare a writable logs dir and drop root privileges
RUN mkdir -p logs && chown -R node:node /app
USER node

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/auth/status || exit 1

# Start application
CMD ["node", "server.js"]
