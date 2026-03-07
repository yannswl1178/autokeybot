FROM node:22-slim

WORKDIR /app

# 複製 package 檔案並安裝依賴
COPY package.json package-lock.json ./
RUN npm ci --production

# 複製應用程式碼
COPY . .

# 暴露端口
EXPOSE 3000

# 啟動
CMD ["node", "bot.js"]
