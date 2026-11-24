FROM node:20-alpine

WORKDIR /app

# Install server deps
COPY server/package.json server/
RUN cd server && npm install --production

# Install client deps and build
COPY client/package.json client/
RUN cd client && npm install

COPY client/ client/
# Engine version stamps: Railway passes the commit as a build variable (no .git in the image).
ARG RAILWAY_GIT_COMMIT_SHA
RUN cd client && npm run build

# Copy server
COPY server/ server/

# Expose port
EXPOSE 3001

# Start server (serves React build from client/dist)
CMD ["node", "server/index.js"]
