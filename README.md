# OmniTutor v3

Document-grounded AI study workspace.

OmniTutor answers from uploaded source files only. Chat, quiz, and flashcards stay locked to the indexed documents in the active session.

## Features
- Document-grounded chat
- Multi-provider AI settings: Ollama, Gemini, OpenAI, Groq, DeepSeek, Custom OpenAI-compatible
- Study mode, quiz, flashcards, pomodoro, progress dashboard
- File upload support: PDF, TXT, MD, PNG, JPG, WEBP, PPT/PPTX
- Session persistence on disk

## Runtime Modes
### Docker first
1. Make sure Docker Desktop is running.
2. If you want local Ollama inside Docker, make sure Ollama is reachable on the host at `http://localhost:11434`.
3. Start the app:
```powershell
start.bat
```
Or:
```powershell
docker compose up --build -d
```
4. Open [http://localhost:3030](http://localhost:3030).

### Local Node runtime
```powershell
npm install
node server.js
```
Then open [http://localhost:3030](http://localhost:3030).

Security note:
- Local Node runtime now binds to `127.0.0.1` by default.
- If you explicitly want LAN access, set `HOST=0.0.0.0`.
- Docker keeps `0.0.0.0` inside the container so browser access through `localhost:3030` still works normally.

## Share On GitHub
Before publishing this project:
- Do not publish `data/config.json` with real API keys inside it.
- `data/`, `.env`, `node_modules/`, uploads, and runtime logs are already ignored by `.gitignore`.
- Create a fresh `.env` from `.env.example` if you want environment-based defaults.
- If you already used a real Gemini/OpenAI/Groq/DeepSeek key locally, rotate it before sharing.
- Your personal local settings can stay on your machine; they are not meant to be committed.

Typical GitHub flow:
```powershell
git init
git add .
git commit -m "Initial OmniTutor v3"
git branch -M main
git remote add origin <YOUR_GITHUB_REPO_URL>
git push -u origin main
```

## Friend Setup
Your friends have 2 realistic ways to use the app.

### Option 1: Run it locally with Docker
Best when each person will use their own AI provider or their own Ollama instance.

Steps:
1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. Clone the repo:
```powershell
git clone <YOUR_GITHUB_REPO_URL>
cd omnitutor-v3
```
3. Start the app:
```powershell
start.bat
```
or
```powershell
docker compose up --build -d
```
4. Open [http://localhost:3030](http://localhost:3030).
5. In Settings:
   - choose `Ollama` if they already have Ollama running locally, or
   - choose a cloud provider and enter their own API key.

Notes:
- For local Ollama, `http://localhost:11434` is enough; the app normalizes `/v1`.
- For PowerPoint preview generation on Windows, Microsoft PowerPoint should be installed if they want PPT/PPTX rendered as slide preview instead of text-only fallback.

### Option 2: Deploy it once and share a URL
Best when you want a central hosted app for the whole group.

What this means:
- You deploy the app to one machine or cloud host.
- Your friends open one shared URL in the browser.
- You must decide who pays for AI usage and how provider keys are managed.

If you want this mode, GitHub alone is not enough. You also need:
- a server/VPS or a cloud platform,
- persistent storage for `data/`,
- one approved AI provider strategy.

## Recommended Sharing Strategy
For now, the simplest stable route is:
1. Publish the code to GitHub.
2. Let each friend run it locally with Docker.
3. Let each friend choose either:
   - local Ollama, or
   - their own cloud API key.

## AI Provider Notes
### Ollama
- Local runtime default: `http://localhost:11434/v1`
- Docker runtime default: `http://host.docker.internal:11434/v1`
- You can enter `http://localhost:11434` or `http://localhost:11434/v1`; the server normalizes it.
- The settings test endpoint reports available models and whether the selected model is local or cloud-backed when Ollama exposes that metadata.

### Cloud providers
- Gemini, OpenAI, Groq, DeepSeek, and Custom profiles are stored separately.
- Provider test results are kept per profile.
- There is no silent fallback between providers.

## Strict Source Mode
- Chat requires at least one indexed document.
- Quiz and flashcards also require indexed documents.
- If the requested answer is not present in the uploaded material, the app returns an out-of-scope response instead of using outside knowledge.

## Settings Storage
Settings are stored in `data/config.json` with per-provider profiles:
- `activeProvider`
- `profiles.<provider>.apiKey`
- `profiles.<provider>.model`
- `profiles.<provider>.baseUrl`
- `profiles.<provider>.lastTest`

## Docker Compose
The included `docker-compose.yml` exposes the app on port `3030` and wires `host.docker.internal` for host Ollama access.

## Development Notes
- Runtime data is stored under `data/`
- Uploaded temp files are cleaned after processing
- Session files are stored under `data/sessions/`
- Runtime logs `server.out.log` and `server.err.log` are ignored
