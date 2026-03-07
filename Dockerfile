FROM node:22-slim

WORKDIR /app

# Copy package files first
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --production

# Copy the rest of the application
COPY bot.js google_apps_script_bot.js ./

# Expose port for the Express API
EXPOSE 3000

# Start the bot
CMD ["node", "bot.js"]
