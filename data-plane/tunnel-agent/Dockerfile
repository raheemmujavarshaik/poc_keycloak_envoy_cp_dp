FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
# No EXPOSE directive: this process never listens for inbound connections.
CMD ["node", "src/index.js"]
