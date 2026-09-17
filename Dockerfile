FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
ENV DB_PATH=/app/data/timeflow.db
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "server.js"]
