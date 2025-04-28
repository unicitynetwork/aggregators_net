FROM node:22.14.0
WORKDIR /aggregator
COPY package.json package.json
COPY package-lock.json package-lock.json
RUN npm install
COPY . .
RUN npm run build
CMD [ "node", "-r", "dotenv/config", "dist/index.cjs" ]
