# Zen Free Gateway - Docker 镜像
#
# 零依赖:仅 Node.js 内置模块,无需 npm install / bun。
# 数据目录默认 /data(config.json / usage.json / info.txt),建议挂载持久化卷。
#
# 构建:  docker build -t zen-gateway .
# 运行:  docker run -p 9527:9527 -v zen-data:/data zen-gateway
#
FROM node:20-alpine

# NODE_ENV=production 只是惯例(本应用不读它,纯内置模块);
# ZEN_DATA_DIR 指向可写数据目录,config.json/usage.json 持久化于此
ENV NODE_ENV=production \
    ZEN_DATA_DIR=/data \
    ZEN_HOST=0.0.0.0

WORKDIR /app

# 仅拷贝运行所需代码(详见 .dockerignore)
COPY desktop-app/ /app/desktop-app/

# 以非 root 运行;数据目录与程序目录都归 node 用户
RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 9527

WORKDIR /app/desktop-app
CMD ["node", "cli.js"]
