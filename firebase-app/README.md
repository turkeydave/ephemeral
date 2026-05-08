# Firebase App (prototype)

This folder contains a minimal web app and a Cloud Function trigger for prototyping.

Quick start

1. Set your Firebase project id in the environment or `.firebaserc`:

```bash
export FIREBASE_PROJECT=your-project-id
```

2. Build and run the emulator container:

```bash
docker compose up --build
```

3. In another shell you can inspect Firestore emulator on port `8080` and the Emulator UI on `4000`.

4. Edit `firebase-app/app/main.js` and replace the `firebaseConfig` placeholders with your web app config.

Files

- `functions/index.js` — Firestore `onUpdate` trigger that writes `taskHistory` records.
- `app/index.html` & `app/main.js` — simple client that lists top 50 tasks.

Local emulator (Docker) and development

- For local development we recommend using the Firebase emulators inside the provided Docker container. The client `main.js` will automatically connect to the Firestore emulator when you open the app at `http://localhost`.

- Start the emulators (from the repo root):

```powershell
$env:FIREBASE_PROJECT='your-project-id'
docker compose up --build
```

- Open the Emulator UI at http://localhost:4000 to inspect Firestore and Functions.

- Serve the web app locally (so `window.location` is `localhost` and the client connects to emulator):

```bash
# from firebase-app
npx http-server ./app -p 3000
# then open http://localhost:3000
```

- If you don't have a service account and can't create keys, use Application Default Credentials for local admin tools (optional):

```powershell
gcloud auth application-default login
```

- Notes:
	- The emulators do not require service account keys. The client uses the Firestore emulator directly when running on `localhost`.
	- When you later deploy functions or use real Firestore, follow secure authentication patterns (ADC, impersonation, or workload identity) instead of long-lived JSON keys.
