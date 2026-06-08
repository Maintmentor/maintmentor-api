# MaintMentor Node.js SDK

Minimal Node.js client for the [MaintMentor Agent API](https://api.maintmentor.ai).

Zero external dependencies — uses Node.js built-in `https` module.

---

## Installation

Copy `maintmentor-client.js` into your project, or require it directly:

```js
const MaintMentorClient = require('./maintmentor-client');
```

> **npm package coming soon.** For now, include the file directly.

---

## Quick Start

```js
const MaintMentorClient = require('./maintmentor-client');

const client = new MaintMentorClient({
  apiKey: 'mm_pk_your_key_here',
});

// Ask a maintenance question
const { answer, confidence, wallet_balance } = await client.query(
  'My HVAC is making a loud banging noise when it starts up. What could cause this?'
);
console.log(answer);
// → "A loud banging noise on startup often indicates a loose blower wheel..."

console.log(`Confidence: ${(confidence * 100).toFixed(0)}%`);
console.log(`Remaining balance: ${wallet_balance} credits`);
```

---

## API Reference

### `new MaintMentorClient(options)`

| Option   | Type   | Default                       | Description                  |
|----------|--------|-------------------------------|------------------------------|
| `apiKey` | string | *required*                    | Your `mm_pk_...` API key     |
| `baseUrl`| string | `https://api.maintmentor.ai`  | API base URL (for testing)   |
| `timeout`| number | `30000`                       | Request timeout (ms)         |

```js
const client = new MaintMentorClient({
  apiKey:   'mm_pk_abc123',
  timeout:  15000,        // 15 seconds
});
```

---

### `client.query(question, [options])` → `Promise<QueryResponse>`

Submit a text maintenance question. **Costs 5 credits.**

**Parameters:**

| Param                     | Type   | Description                                 |
|---------------------------|--------|---------------------------------------------|
| `question`                | string | Your maintenance question (max 2000 chars)  |
| `options.context`         | object | Optional appliance context                  |
| `options.context.appliance_type` | string | e.g. `"HVAC"`, `"Plumbing"` |
| `options.context.model`   | string | Appliance model number                      |
| `options.context.age_years` | number | Appliance age in years                   |
| `options.response_format` | string | `"text"` (default) or `"structured"`       |

**Response:**

```js
{
  answer:         "A loud banging noise...",   // AI guidance
  confidence:     0.85,                         // 0.0–1.0
  credits_used:   5,
  wallet_balance: 45.0,
  request_id:     "a3f1c2d4-..."
}
```

**Example:**

```js
const result = await client.query(
  'My water heater makes a popping sound. Should I be worried?',
  {
    context: {
      appliance_type: 'Water Heater',
      age_years: 12,
    },
  }
);
console.log(result.answer);
```

---

### `client.photo(question, images)` → `Promise<PhotoResponse>`

Analyze photos of a maintenance issue. **Costs 15 credits.**

Accepts up to 5 images as base64 data URIs or HTTPS URLs.

**Parameters:**

| Param     | Type     | Description                                          |
|-----------|----------|------------------------------------------------------|
| `question`| string   | What you want to know about the image(s)             |
| `images`  | string[] | Array of `data:image/jpeg;base64,...` or HTTPS URLs  |

**Response:**

```js
{
  answer:         "The image shows water damage around...",
  confidence:     0.78,
  issues_found:   ["Water stain", "Rust on pipe"],
  severity:       "medium",    // "low" | "medium" | "high" | "critical"
  credits_used:   15,
  wallet_balance: 30.0,
  request_id:     "b4g2h3i4-..."
}
```

**Example — file upload:**

```js
const fs = require('fs');

const imageBase64 = fs.readFileSync('./ceiling-stain.jpg').toString('base64');

const { answer, issues_found, severity } = await client.photo(
  'What is causing this stain on my ceiling?',
  [`data:image/jpeg;base64,${imageBase64}`]
);

console.log(`Issues: ${issues_found.join(', ')}`);
console.log(`Severity: ${severity}`);
```

**Example — URL:**

```js
const { answer } = await client.photo(
  'Is this outlet safe?',
  ['https://example.com/images/outlet.jpg']
);
```

---

### `client.usage()` → `Promise<UsageResponse>`

Get wallet balance and usage stats. **Free (0 credits).**

**Response:**

```js
{
  wallet_balance: 30.0,
  today:      { queries: 3,  photos: 1,  credits_used: 30  },
  this_month: { queries: 47, photos: 12, credits_used: 415 },
  lifetime:   { queries: 203, photos: 41, credits_used: 1630 }
}
```

**Example:**

```js
const stats = await client.usage();
console.log(`Balance: ${stats.wallet_balance} credits`);
console.log(`Queries today: ${stats.today.queries}`);

if (stats.wallet_balance < 50) {
  console.warn('Low balance! Top up at https://maintmentor.ai/dashboard');
}
```

---

## Error Handling

All methods throw `MaintMentorError` on API failures:

```js
const { MaintMentorError } = require('./maintmentor-client');

try {
  const result = await client.query('My boiler is broken');
} catch (err) {
  if (err instanceof MaintMentorError) {
    console.error(`API error [${err.status}] ${err.code}: ${err.message}`);

    switch (err.code) {
      case 'INSUFFICIENT_BALANCE':
        console.error('Top up your wallet at https://maintmentor.ai/dashboard');
        break;
      case 'RATE_LIMIT_EXCEEDED':
        console.error(`Slow down! Retry after ${err.retryAfter}s`);
        break;
      case 'INVALID_API_KEY':
        console.error('Check your API key at https://maintmentor.ai/dashboard');
        break;
    }
  } else {
    // Network error, timeout, etc.
    console.error('Network error:', err.message);
  }
}
```

---

## Checking Balance Before Expensive Calls

```js
async function safeQuery(client, question) {
  // Check balance first (free)
  const { wallet_balance } = await client.usage();

  if (wallet_balance < 5) {
    throw new Error('Insufficient balance. Top up at https://maintmentor.ai/dashboard');
  }

  return client.query(question);
}
```

---

## Full Example: Maintenance Bot

```js
'use strict';

const MaintMentorClient = require('./maintmentor-client');
const { MaintMentorError } = require('./maintmentor-client');

const client = new MaintMentorClient({
  apiKey: process.env.MAINTMENTOR_API_KEY,
});

async function handleMaintenanceRequest(userQuestion, imagePaths = []) {
  try {
    // Check balance first
    const { wallet_balance } = await client.usage();
    console.log(`Wallet balance: ${wallet_balance} credits`);

    let result;

    if (imagePaths.length > 0) {
      // Photo analysis
      const fs = require('fs');
      const images = imagePaths.map(p =>
        `data:image/jpeg;base64,${fs.readFileSync(p).toString('base64')}`
      );
      result = await client.photo(userQuestion, images);
      console.log('Issues found:', result.issues_found);
      console.log('Severity:', result.severity);
    } else {
      // Text query
      result = await client.query(userQuestion, {
        context: { appliance_type: 'general' },
      });
    }

    console.log('\n=== MaintMentor Response ===');
    console.log(result.answer);
    console.log(`\nConfidence: ${(result.confidence * 100).toFixed(0)}%`);
    console.log(`Credits used: ${result.credits_used}`);

    return result;
  } catch (err) {
    if (err instanceof MaintMentorError) {
      console.error(`API error [${err.code}]: ${err.message}`);
    } else {
      console.error('Unexpected error:', err.message);
    }
    throw err;
  }
}

// Run
handleMaintenanceRequest('How do I reset a tripped GFCI outlet?')
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
```

---

## Rate Limits

| Endpoint       | Limit              |
|-----------------|-------------------|
| POST /query    | 100 req/min        |
| POST /photo    | 10 req/min         |
| GET  /usage    | 100 req/min        |

When rate limited, the API returns HTTP 429. The response includes `retryAfter`
(seconds). Implement exponential backoff in production systems.

---

## Credits Pricing

| Action         | Credits |
|----------------|---------|
| Text query     | 5       |
| Photo analysis | 15      |
| Check usage    | 0 (free) |

Top up credits at [maintmentor.ai/dashboard](https://maintmentor.ai/dashboard).

---

## Support

- Documentation: https://maintmentor.ai/docs
- Email: support@maintmentor.ai
