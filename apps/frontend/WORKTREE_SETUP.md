# Git Worktree Setup Overview

## Helper Scripts

Three helper scripts are available in the main worktree (`4prop-crm-react/`):

1. **`create-worktree.sh`** - Create new worktrees with all workarounds applied automatically
2. **`safe-remove-worktree.sh`** - Safely remove worktrees with uncommitted change detection
3. **`recover-worktree.sh`** - Recover accidentally deleted worktrees

## Directory Structure

```
/Users/salgadom/EACH/each-monorepo/apps/frontend/
│
├── 4prop-crm-react/          # Main worktree
│   ├── Branch: develop
│   ├── Tailwind: v3.4.1
│   ├── Port: 5173
│   └── Purpose: Production/stable version
│
├── 4prop-crm-react-tw4/      # Tailwind v4 test worktree
│   ├── Branch: feature/tailwind-v4-migration
│   ├── Tailwind: v4.1.18
│   ├── Port: 5174
│   ├── Package: react-4prop-crm-tw4
│   └── Purpose: Test Tailwind v4 migration
│
└── 4prop-crm-react-mobile/   # Mobile improvements worktree
    ├── Branch: feature/mobile-responsive-improvements
    ├── Tailwind: v4.1.18
    ├── Port: 5175
    ├── Package: react-4prop-crm-mobile
    └── Purpose: Mobile responsive improvements (based on v4)
```

## Branch Relationships

```
develop (main)
    │
    └── feature/tailwind-v4-migration
            │
            └── feature/mobile-responsive-improvements
```

## Creating New Worktrees

### Using the Helper Script (Recommended)

```bash
cd /Users/salgadom/EACH/each-monorepo/apps/frontend/4prop-crm-react
./create-worktree.sh feature/my-feature ../4prop-crm-react-myfeature
```

This automatically:
- ✅ Creates the worktree
- ✅ Updates package.json name (workaround)
- ✅ Configures git to ignore package.json
- ✅ Installs dependencies
- ✅ Creates WORKTREE_INFO.md documentation

**Examples:**
```bash
# Create from existing branch
./create-worktree.sh feature/dark-mode ../4prop-crm-react-darkmode

# Create new branch and worktree
./create-worktree.sh feature/api-v2 ../4prop-crm-react-api

# Create from specific base branch
./create-worktree.sh feature/redesign ../4prop-crm-react-redesign feature/tailwind-v4-migration
```

### Manual Creation (Advanced)

If you prefer manual control:

```bash
# 1. Create worktree
git worktree add ../4prop-crm-react-myfeature feature/my-feature

# 2. Apply package.json workaround
cd ../4prop-crm-react-myfeature
sed -i '' 's/"name": "react-4prop-crm"/"name": "react-4prop-crm-myfeature"/' package.json

# 3. Configure git to ignore it
git update-index --assume-unchanged package.json

# 4. Install dependencies
cd /Users/salgadom/EACH/each-monorepo
npm install
```

## Quick Start Commands

### Terminal 1 - Tailwind v3 (Stable)
```bash
cd /Users/salgadom/EACH/each-monorepo/apps/frontend/4prop-crm-react
npm run dev:crm
```
**URL**: https://localhost:5173/crm

### Terminal 2 - Tailwind v4 (Testing)
```bash
cd /Users/salgadom/EACH/each-monorepo/apps/frontend/4prop-crm-react-tw4
./start-v4.sh
# or: PORT=5174 npm run dev:crm
```
**URL**: https://localhost:5174/crm

### Terminal 3 - Mobile Improvements (Development)
```bash
cd /Users/salgadom/EACH/each-monorepo/apps/frontend/4prop-crm-react-mobile
./start-mobile.sh
# or: PORT=5175 npm run dev:crm
```
**URL**: https://localhost:5175/crm

## Use Cases

### 🔍 Compare v3 vs v4
Run terminals 1 and 2, compare side-by-side

### 📱 Work on Mobile Improvements
Use terminal 3, test responsive features

### 🎯 Compare All Three
Run all terminals simultaneously, compare:
- v3: Original stable version
- v4: With all v4 improvements
- mobile: v4 + mobile enhancements

## Git Operations

### Check Current Worktrees
```bash
git worktree list
```

### Switch Between Worktrees
Just `cd` to different directories - no git checkout needed!

```bash
cd /Users/salgadom/EACH/each-monorepo/apps/frontend/4prop-crm-react-mobile
git status  # Shows: feature/mobile-responsive-improvements
```

### Make Changes in Mobile Worktree
```bash
cd /Users/salgadom/EACH/each-monorepo/apps/frontend/4prop-crm-react-mobile
# Edit files...
git add .
git commit -m "📱 feat: improve mobile navigation"
```

### Push Changes
```bash
git push origin feature/mobile-responsive-improvements
```

## Merging Strategy

When ready to merge:

```bash
# 1. Merge Tailwind v4 to develop first
cd /Users/salgadom/EACH/each-monorepo/apps/frontend/4prop-crm-react
git checkout develop
git merge feature/tailwind-v4-migration
git push origin develop

# 2. Then merge mobile improvements
git merge feature/mobile-responsive-improvements
git push origin develop

# 3. Clean up worktrees
git worktree remove ../4prop-crm-react-tw4
git worktree remove ../4prop-crm-react-mobile

# 4. Clean up branches (optional)
git branch -d feature/tailwind-v4-migration
git branch -d feature/mobile-responsive-improvements
```

## Cleanup

### Safely Remove a Worktree (Recommended)
```bash
cd /Users/salgadom/EACH/each-monorepo/apps/frontend/4prop-crm-react
./safe-remove-worktree.sh ../4prop-crm-react-mobile
```

This script will:
- Check for uncommitted changes
- Warn you before deletion
- Show what will be preserved (the branch)
- Update npm workspace automatically

### Manual Remove a Worktree
```bash
cd /Users/salgadom/EACH/each-monorepo/apps/frontend/4prop-crm-react
git worktree remove ../4prop-crm-react-mobile

# Force remove if there are uncommitted changes (⚠️ LOSES CHANGES!)
git worktree remove ../4prop-crm-react-mobile --force
```

### Update npm Workspace
After removing worktrees:
```bash
cd /Users/salgadom/EACH/each-monorepo
npm install
```

### Remove All Test Worktrees
```bash
cd /Users/salgadom/EACH/each-monorepo/apps/frontend/4prop-crm-react
git worktree remove ../4prop-crm-react-tw4
git worktree remove ../4prop-crm-react-mobile
cd /Users/salgadom/EACH/each-monorepo
npm install
```

## Recovery

### Accidentally Removed a Worktree?

**Use the recovery script:**
```bash
cd /Users/salgadom/EACH/each-monorepo/apps/frontend/4prop-crm-react
./recover-worktree.sh
```

This interactive script will:
- Show current worktrees and branches
- Detect missing worktrees
- Help you recreate any worktree
- Recover branches from reflog if needed
- Re-apply all workarounds automatically

### Manual Recovery

**If the branch still exists:**
```bash
# Recreate the worktree
git worktree add ../4prop-crm-react-mobile feature/mobile-responsive-improvements

# Re-apply workarounds
cd ../4prop-crm-react-mobile
sed -i '' 's/"name": "react-4prop-crm"/"name": "react-4prop-crm-mobile"/' package.json
git update-index --assume-unchanged package.json

# Reinstall
cd /Users/salgadom/EACH/each-monorepo
npm install
```

**If the branch was also deleted:**
```bash
# Find the branch in reflog
git reflog | grep mobile-responsive-improvements

# Restore from commit hash
git branch feature/mobile-responsive-improvements <commit-hash>

# Then recreate worktree (see above)
```

**If you deleted the directory manually:**
```bash
# Clean up git's tracking
git worktree prune

# Then recreate (see above)
```

## Troubleshooting

### Port Already in Use
```bash
# Find process on port
lsof -ti:5175 | xargs kill -9

# Or use different port
PORT=5176 npm run dev:crm
```

### npm Workspace Conflicts
Each worktree has a unique package name:
- `react-4prop-crm` (main)
- `react-4prop-crm-tw4` (v4 test)
- `react-4prop-crm-mobile` (mobile)

### Dependency Issues
```bash
# Reinstall from monorepo root
cd /Users/salgadom/EACH/each-monorepo
npm install
```

### Clear Vite Cache
```bash
cd /Users/salgadom/EACH/each-monorepo/apps/frontend/4prop-crm-react-mobile
rm -rf node_modules/.vite
```

## Documentation Files

Each worktree has its own docs:

- **4prop-crm-react**: Standard project docs
- **4prop-crm-react-tw4**:
  - `TAILWIND_V4_MIGRATION.md` - Migration guide
  - `RUN_COMPARISON.md` - Comparison instructions
  - `start-v4.sh` - Quick start script
- **4prop-crm-react-mobile**:
  - `MOBILE_IMPROVEMENTS.md` - Mobile development guide
  - `start-mobile.sh` - Quick start script

## Benefits of This Setup

✅ Work on three versions simultaneously
✅ No need to stash/commit when switching
✅ Compare versions side-by-side in browser
✅ Test mobile improvements based on v4
✅ Independent development environments
✅ Shared monorepo dependencies (efficient)

## Quick Reference

| Worktree | Branch | Tailwind | Port | Package Name |
|----------|--------|----------|------|--------------|
| 4prop-crm-react | develop | v3.4.1 | 5173 | react-4prop-crm |
| 4prop-crm-react-tw4 | feature/tailwind-v4-migration | v4.1.18 | 5174 | react-4prop-crm-tw4 |
| 4prop-crm-react-mobile | feature/mobile-responsive-improvements | v4.1.18 | 5175 | react-4prop-crm-mobile |
