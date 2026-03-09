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
COPY src/ ./src/
COPY config/ ./config/
COPY training/ ./training/

VOLUME ["/app/models", "/app/data"]

CMD ["node", "src/index.js"]
