FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# Copy package files
COPY package*.json tsconfig.json ./
COPY src ./src

# Prevent Playwright from attempting to download browsers during npm install
# The base image already contains the browsers, so we can skip downloads here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install dependencies
RUN npm install --unsafe-perm

# Build TypeScript
RUN npm run build

# Create data directory
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "dist/index.js"]
