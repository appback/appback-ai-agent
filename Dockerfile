FROM node:18-alpine

WORKDIR /app

# Python for training pipeline
RUN apk add --no-cache python3 py3-pip && \
    python3 -m pip install --break-system-packages --no-cache-dir \
    torch --index-url https://download.pytorch.org/whl/cpu && \
    python3 -m pip install --break-system-packages --no-cache-dir \
    numpy pandas scikit-learn onnx onnxruntime

# Node.js dependencies
COPY package.json package-lock.json* ./
RUN npm ci --production

# Application
COPY bin/ ./bin/
COPY src/ ./src/
COPY config/ ./config/
COPY bootstrap/ ./bootstrap/
COPY training/ ./training/
COPY .env.example ./

RUN chmod 0755 ./bin/cli.js

VOLUME ["/app/models", "/app/data"]

CMD ["node", "bin/cli.js", "start"]
