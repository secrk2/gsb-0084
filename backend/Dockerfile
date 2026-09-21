FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /data/uploads

EXPOSE 3000

# 首次启动自动建表 + 仅在库为空时灌入种子数据
CMD ["sh", "./scripts/docker-entrypoint.sh"]
