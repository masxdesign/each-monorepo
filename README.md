# EACH Monorepo

npm workspace monorepo for EACH applications and shared packages.

## 📁 Structure

```
EACH/
├── apps/
│   ├── backend/
│   │   ├── bizchat/           # BizChat backend API
│   │   └── property-pub/      # Property Publishing backend API
│   ├── frontend/
│   │   ├── property-pub-react/ # Property Publishing React frontend
│   │   └── 4prop-crm-react/    # 4prop CRM React frontend
│   └── swa/
│       └── shopproperty-swa/   # Shop Property Static Web App
└── packages/
    └── backend-shared/
        └── oauth/              # Shared OAuth authentication plugin
```

## 🚀 Getting Started

### Initial Clone

```bash
# Clone the monorepo
git clone <your-monorepo-url> EACH
cd EACH

# Initialize and clone all submodules
git submodule init
git submodule update

# Install all workspace dependencies
npm install
```

### Quick Commands

```bash
# Run specific workspace
npm run dev --workspace=bizchat
npm run dev --workspace=property-pub
npm run dev --workspace=property-pub-react

# Run all workspaces (if they have a dev script)
npm run dev --workspaces

# Install a package in a specific workspace
npm install express --workspace=bizchat

# List all workspaces
npm ls --workspaces --depth=0
```

## 📦 Workspaces

### Backend Apps

- **bizchat** - BizChat messaging and scheduling platform
  - Repo: https://github.com/eachcorp/4prop-bizchat.git
  - Port: 3000

- **property-pub** - Property publishing API
  - Repo: https://github.com/eachcorp/property-pub-web.git
  - Port: 8080

### Frontend Apps

- **property-pub-react** - Property publishing React frontend
  - Repo: git@github.com:masxdesign/react-4prop-agentb.git

- **4prop-crm-react** - 4prop CRM React frontend
  - Repo: https://github.com/masxdesign/react-4prop-crm.git

### Static Web Apps (SWA)

- **shopproperty-swa** - Shop Property Static Web App
  - Repo: https://github.com/eachcorp/shopproperty-swa.git

### Shared Packages

- **@4prop/oauth** - OAuth authentication plugin for Express.js
  - Repo: https://github.com/masxdesign/4prop-oauth-plugin.git

## 🔄 Working with Submodules

### Update All Submodules

```bash
# Pull latest changes for all submodules
git submodule update --remote --merge
```

### Update Specific Submodule

```bash
# Navigate to submodule
cd apps/backend/bizchat

# Pull latest changes
git pull origin main

# Go back to root and commit the submodule update
cd ../../..
git add apps/backend/bizchat
git commit -m "Update bizchat submodule"

# Remove any existing workspace lockfiles
rm -f apps/backend/*/code/package-lock.json
rm -f apps/frontend/*/package-lock.json
rm -f packages/*/*/package-lock.json
```

### Making Changes in a Submodule

```bash
# Navigate to the submodule
cd apps/backend/bizchat

# Make changes, commit, and push as normal
git add .
git commit -m "Your changes"
git push origin main

# Go back to root and update the submodule reference
cd ../../..
git add apps/backend/bizchat
git commit -m "Update bizchat submodule reference"
git push
```

## 🐳 Docker Support

The monorepo supports Docker with both development and production configurations.

### Development Mode

Use this for local development with hot-reload:

**docker-compose.dev.yml:**
```yaml
version: '3.8'
services:
  bizchat:
    image: node:22-alpine
    working_dir: /workspace
    command: npm run dev --workspace=bizchat
    ports:
      - "3000:3000"
    volumes:
      - .:/workspace
      - /workspace/node_modules
    environment:
      - NODE_ENV=development
    env_file:
      - apps/backend/bizchat/code/.env

  property-pub:
    image: node:22-alpine
    working_dir: /workspace
    command: npm run dev --workspace=property-pub
    ports:
      - "8080:8080"
    volumes:
      - .:/workspace
      - /workspace/node_modules
    environment:
      - NODE_ENV=development
    env_file:
      - apps/backend/property-pub/code/.env

  property-pub-react:
    image: node:22-alpine
    working_dir: /workspace
    command: npm run dev --workspace=property-pub-react
    ports:
      - "5173:5173"
    volumes:
      - .:/workspace
      - /workspace/node_modules
    environment:
      - NODE_ENV=development
```

**Usage:**
```bash
# Install dependencies first (on host)
npm install

# Start all services
docker-compose -f docker-compose.dev.yml up

# Start specific service
docker-compose -f docker-compose.dev.yml up bizchat

# Stop all services
docker-compose -f docker-compose.dev.yml down
```

### Production Mode

Use individual Dockerfiles for production builds:

#### BizChat Dockerfile

Create `apps/backend/bizchat/Dockerfile`:

```dockerfile
FROM node:22-alpine AS base

# Install dependencies for the entire workspace
WORKDIR /app
COPY package*.json ./
COPY apps/backend/bizchat/code/package*.json ./apps/backend/bizchat/code/

# Install all workspace dependencies
RUN npm ci --only=production

# Copy application code
COPY apps/backend/bizchat ./apps/backend/bizchat

# Set working directory to the app
WORKDIR /app/apps/backend/bizchat/code

# Expose port
EXPOSE 3000

# Start application
CMD ["npm", "run", "start"]
```

#### Property-Pub Dockerfile

Create `apps/backend/property-pub/Dockerfile`:

```dockerfile
FROM node:22-alpine AS base

WORKDIR /app

# Copy workspace files
COPY package*.json ./
COPY apps/backend/property-pub/code/package*.json ./apps/backend/property-pub/code/
COPY packages/backend-shared/oauth/package.json ./packages/backend-shared/oauth/

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY apps/backend/property-pub ./apps/backend/property-pub
COPY packages/backend-shared/oauth ./packages/backend-shared/oauth

WORKDIR /app/apps/backend/property-pub/code

EXPOSE 8080

CMD ["npm", "run", "start"]
```

#### Property-Pub-React Dockerfile

Create `apps/frontend/property-pub-react/Dockerfile`:

```dockerfile
# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace files
COPY package*.json ./
COPY apps/frontend/property-pub-react/package*.json ./apps/frontend/property-pub-react/

# Install dependencies
RUN npm ci

# Copy source
COPY apps/frontend/property-pub-react ./apps/frontend/property-pub-react

# Build the app
WORKDIR /app/apps/frontend/property-pub-react
RUN npm run build

# Production stage
FROM nginx:alpine
COPY --from=builder /app/apps/frontend/property-pub-react/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
```

#### Production docker-compose.yml

```yaml
version: '3.8'
services:
  bizchat:
    build:
      context: .
      dockerfile: apps/backend/bizchat/Dockerfile
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    env_file:
      - apps/backend/bizchat/code/.env.production
    restart: unless-stopped

  property-pub:
    build:
      context: .
      dockerfile: apps/backend/property-pub/Dockerfile
    ports:
      - "8080:8080"
    environment:
      - NODE_ENV=production
    env_file:
      - apps/backend/property-pub/code/.env.production
    restart: unless-stopped

  property-pub-react:
    build:
      context: .
      dockerfile: apps/frontend/property-pub-react/Dockerfile
    ports:
      - "80:80"
    restart: unless-stopped
```

**Usage:**
```bash
# Build and start all services
docker-compose up -d --build

# View logs
docker-compose logs -f

# Stop all services
docker-compose down

# Rebuild specific service
docker-compose up -d --build bizchat
```

### Docker Best Practices

1. **Build Context**: Always use the monorepo root (`.`) as build context
2. **Layer Caching**: Copy `package.json` files before source code for better caching
3. **Shared Packages**: Always copy shared packages (like `@4prop/oauth`) that workspaces depend on
4. **Environment Files**: Keep `.env` files in each workspace directory
5. **Volume Mounting**: In dev mode, mount entire workspace but exclude `node_modules`

### Individual Workspace Docker Commands

```bash
# Build bizchat
docker build -t bizchat:latest -f apps/backend/bizchat/Dockerfile .

# Run bizchat
docker run -p 3000:3000 --env-file apps/backend/bizchat/code/.env bizchat:latest

# Build property-pub
docker build -t property-pub:latest -f apps/backend/property-pub/Dockerfile .

# Run property-pub
docker run -p 8080:8080 --env-file apps/backend/property-pub/code/.env property-pub:latest

# Build property-pub-react
docker build -t property-pub-react:latest -f apps/frontend/property-pub-react/Dockerfile .

# Run property-pub-react
docker run -p 80:80 property-pub-react:latest
```

## 📝 Adding New Workspaces

1. Add the repo as a submodule:
   ```bash
   git submodule add <repo-url> apps/backend/new-app
   ```

2. Update root `package.json` if needed (workspaces are auto-detected via glob patterns)

3. Run `npm install` to link the new workspace

## ⚠️ Troubleshooting

### Submodules not initialized

```bash
git submodule init
git submodule update
```

### Workspace dependencies not found

```bash
# Linux
rm -rf node_modules package-lock.json

# Windows
Remove-Item -Recurse -Force node_modules, package-lock.json

npm install
```

### Submodule conflicts

```bash
# Reset submodule to tracked commit
git submodule update --force
```

## 🤝 Contributing

Each workspace maintains its own repository. Please refer to individual workspace repositories for contribution guidelines.
