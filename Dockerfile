FROM ghcr.io/puppeteer/puppeteer:22

USER root

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install

COPY . .

ENV PORT=10000
EXPOSE 10000

CMD ["bun", "run", "server.ts"]
