# Stdio MCP so Glama can start Upstream and read tools/list.
# Sample data only: no live checks, no x402 payment, no email, no secrets.
FROM node:22-alpine

WORKDIR /app
COPY glama/stdio.mjs glama/tools.json ./glama/

USER node
CMD ["node", "glama/stdio.mjs"]
