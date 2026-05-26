# MaintMentor.ai — API Server

**Build with Gemini XPRIZE Entry** | Category: Education & Human Potential

AI-powered maintenance training and diagnostics platform for residential property maintenance teams.

## Live Product
🌐 **[maintmentor.ai](https://maintmentor.ai)** — Live at scale with real users

## Google Cloud Integration
- **Cloud Run:** Deployed at `https://maintmentor-api-878722550029.us-east1.run.app`
- **Region:** us-east1
- **Project:** steel-bridge-474518-n2

## Gemini API Integration
This API uses **Gemini API** for all AI functionality:
- `gemini-2.5-pro` — complex diagnostics, photo analysis, safety-related queries
- `gemini-2.5-flash` — simple queries, fast responses

Two-tier routing selects the appropriate model based on query complexity, automatically.

## What This Does
MaintMentor.ai helps apartment maintenance technicians:
- **Diagnose problems** from text descriptions or uploaded photos using Gemini Vision
- **Get step-by-step repair guidance** from an AI mentor with 30+ years of field knowledge
- **Earn professional certifications** in Electrical, HVAC, Plumbing, Appliance Repair, and General Maintenance
- **Learn in any language** — supports 30+ languages for diverse maintenance crews

## Tech Stack
- Node.js + Express
- Gemini API (gemini-2.5-pro + gemini-2.5-flash)
- Google Cloud Run
- Supabase (PostgreSQL)
- Stripe (billing)
- Resend (email)

## API Endpoints
- `POST /api/chat` — AI diagnostic chat (Gemini-powered)
- `GET /api/conversations` — User conversation history
- `GET /api/health` — Service health check

## Health Check
```bash
curl https://maintmentor-api-878722550029.us-east1.run.app/api/health
```

## Local Setup
```bash
npm install
cp .env.example .env  # Add your GEMINI_API_KEY
npm start
```

## Founder
**Dean Richards** | CEO — 30+ years in residential maintenance management  
dean@maintmentor.ai | maintmentor.ai
