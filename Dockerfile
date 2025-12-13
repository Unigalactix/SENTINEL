FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies first (for caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY . .

# Expose port (3000)
EXPOSE 3000

# Start command
CMD ["npm", "start"]
