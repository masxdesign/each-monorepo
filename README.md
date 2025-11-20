# EACH Monorepo

npm workspace monorepo for EACH applications and shared packages.

## 📁 Structure

```
EACH/
├── apps/
│   ├── backend/
│   │   ├── bizchat/           # BizChat backend API
│   │   └── property-pub/      # Property Publishing backend API
│   └── frontend/
│       └── property-pub-react/ # Property Publishing React frontend
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

Each workspace can be run with Docker. See individual workspace README files for Docker setup.

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
rm -rf node_modules package-lock.json
npm install
```

### Submodule conflicts

```bash
# Reset submodule to tracked commit
git submodule update --force
```

## 🤝 Contributing

Each workspace maintains its own repository. Please refer to individual workspace repositories for contribution guidelines.
