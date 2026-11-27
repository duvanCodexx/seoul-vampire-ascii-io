FROM node:22-alpine

WORKDIR /app

COPY package.json server.js index.html README.md ./

ENV PORT=8765

EXPOSE 8765

CMD ["node", "server.js"]
