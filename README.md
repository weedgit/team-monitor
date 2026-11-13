# Team Monitor

Windows 11 apps for one admin and five to ten teammates on the same PC or local network. The admin watches a live grid, opens one display full screen, and reviews recordings by date. Each teammate PC records locally and uploads when the admin is reachable. The admin server only accepts this PC and the local subnet — it will not accept connections from the internet.

## Setup files

Build on Windows 11 x64 from this folder:

```
npm install
npm install --prefix admin-app
npm install --prefix teammate-app
npm test
npm run dist:admin
npm run dist:teammate
```

| Role | Installer |
|---|---|
| Admin | `admin-app/dist/Admin-Setup-1.0.0.exe` |
| Teammate | `teammate-app/dist/Teammate-Setup-1.0.0.exe` |

The admin installer adds a Windows Firewall rule for TCP 3921. Other PCs on the local network can connect. Internet addresses stay blocked. Uninstall removes the rule.

## Run from source

Start the admin first:

```
npm run admin
```

Then on each teammate PC (or a second window on the same PC):

```
npm run teammate
```

In the teammate window, paste the local admin address shown in the admin app (`http://<lan-ip>:3921`). On the same PC use `http://127.0.0.1:3921`. Internet addresses are rejected.

Recording starts after enrollment. If the admin app is closed, the teammate keeps writing one-minute segments per display and uploads them when the admin is back.

The product plan is in [`../doc/plan.md`](../doc/plan.md).
