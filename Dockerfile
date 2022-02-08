FROM node:16-bullseye-slim as build-dependencies-helper

# Create app directory
WORKDIR /app

# The current working directory
COPY . . 

# Install dependencies
RUN yarn workspaces focus -A --production

# Delete TypeScript code and markdown files to further reduce image size
RUN find /app/node_modules | grep ".\.ts" | xargs rm

# TS Build Stage
FROM amd64/node:16-bullseye-slim as middleware-builder

# Change directory to '/app'
WORKDIR /app

# The current working directory
COPY . . 

# Install dependencies
RUN yarn install

# Build TS code
RUN yarn build

# Delete everyhing we don't need in the next stage
# RUN rm -rf node_modules tsconfig.tsbuildinfo *.ts **/*.ts .eslint* .git* .prettier* .vscode* tsconfig.json .yarn* yarn.lock

# Final image
FROM node:16-bullseye-slim AS middleware

# Copy built code from build stage to '/app' directory
COPY --from=middleware-builder /app /app

# Copy node_modules
COPY --from=build-dependencies-helper /app/node_modules /app/node_modules

# Change directory to '/app'
WORKDIR /app

EXPOSE 3006
CMD [ "node", "--experimental-json-modules", "bin/www.mjs" ]
