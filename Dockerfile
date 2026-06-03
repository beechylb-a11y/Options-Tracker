FROM node:20-alpine

WORKDIR /app

# Install server deps
COPY server/package.json server/
RUN cd server && npm install --production

# Install client deps and build
COPY client/package.json client/
RUN cd client && npm install

COPY client/ client/
RUN cd client && npm run build

# Copy server
COPY server/ server/

# Expose port
EXPOSE 3001

# Start server (serves React build from client/dist)
CMD ["node", "server/index.js"]
