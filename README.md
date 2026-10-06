# WhatsApp Automation API

TypeScript and Fastify API that uses Playwright to automate a WhatsApp Web browser session. It provides connection/QR state, messaging and media endpoints, and Docker configurations for persisted sessions.

## Getting started

Use Node.js 22 or later. Run `npm ci`, then `npx playwright install chromium`, and `npm run dev`. Use `npm run build` and `npm start` for compiled execution. The service defaults to port 3000; complete QR login with your own WhatsApp account before sending messages. Docker and multi-instance deployment examples are in the Compose files.

## Author

Author: [Rajiv Ranjan](https://rajivranjan.in).
