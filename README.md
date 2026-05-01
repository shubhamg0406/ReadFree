# ReadFree

ReadFree allows users to read paywalled articles for free.

## What It Does

- Accepts an article URL
- Fetches accessible article content using multiple extraction strategies
- Returns cleaned, reader-friendly content with metadata

## Project Structure

- `frontend/`: Expo React Native app
- `backend/`: FastAPI service for article resolution and extraction

## Quick Start

### 1) Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn server:app --reload --host 0.0.0.0 --port 8000
```

### 2) Frontend

```bash
cd frontend
yarn install
yarn start
```

## Environment Variables (Backend)

Configure these in `backend/.env`:

- `MONGO_URL` (required)
- `DB_NAME` (required)
- `JINA_API_KEY` (optional, for higher Jina Reader limits)

## Disclaimer

Use this project responsibly and only where you have the legal right to access and view content.
