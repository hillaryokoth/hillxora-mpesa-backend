# Hillxora Homes - M-PESA Backend

Simple Node.js backend for M-PESA STK Push integration.

## Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| GET | `/` | Health check |
| POST | `/stk-push` | Initiate STK Push |
| POST | `/callback` | Safaricom callback (automatic) |
| GET | `/transaction/:id` | Check payment status |

## STK Push Request

```json
POST /stk-push
{
  "phone": "254745273776",
  "amount": 5000,
  "accountRef": "RENT-123"
}
```

## Deploy to Render

1. Push this folder to GitHub
2. Go to render.com → New Web Service
3. Connect your GitHub repo
4. Set environment variable: RENDER_URL = your Render URL
5. Deploy!

## After Deploying

Update RENDER_URL in your environment variables with your actual Render URL e.g:
`https://hillxora-mpesa-backend.onrender.com`
