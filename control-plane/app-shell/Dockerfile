FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY vite.config.js index.html ./
COPY src ./src
ARG VITE_ORG_VALIDATION_URL
ARG VITE_BFF_URL
ARG VITE_DATA_PLANE_ID
ENV VITE_ORG_VALIDATION_URL=$VITE_ORG_VALIDATION_URL
ENV VITE_BFF_URL=$VITE_BFF_URL
ENV VITE_DATA_PLANE_ID=$VITE_DATA_PLANE_ID
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY --from=build /app/dist ./dist
COPY vite.config.js ./
EXPOSE 3000
CMD ["npm", "run", "preview"]
