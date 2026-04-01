# Telegram Premium Manager Bot

A Telegram bot for managing premium customers, tracking subscription periods, scheduling renewal reminders, and exporting customer data to Excel.

## Usage Notice

This repository is public for portfolio and reference purposes only.

- viewing and learning from the project is allowed
- commercial use is not allowed
- redistribution is not allowed
- reselling this code or deploying it as your own product is not allowed
- creating derivative commercial versions without written permission is not allowed

## Overview

This project is designed for a single admin workflow:

- add and manage premium customers
- track start dates and expiry dates
- send daily expiry alerts
- send monthly renewal reminders
- export customer records to Excel

## Core Features

- Admin-only access using `ADMIN_ID`
- Customer CRUD inside Telegram chat
- Service-based filtering and search
- Expiry tracking with visual status indicators
- Monthly reminder scheduling
- Excel export for customer records
- PostgreSQL-backed persistence

## Architecture

```mermaid
flowchart TD
    A["Admin on Telegram"] --> B["Telegraf Bot"]
    B --> C["State / Conversation Flow"]
    B --> D["PostgreSQL Database"]
    B --> E["Cron Jobs"]
    E --> B
    B --> F["Telegram Notifications"]
    B --> G["Excel Export"]
```

## Workflow

```mermaid
flowchart LR
    A["Admin starts bot"] --> B["Choose action"]
    B --> C["Add customer"]
    B --> D["View / edit customer"]
    B --> E["Check expiring customers"]
    B --> F["View reminder schedule"]
    B --> G["Export Excel"]

    C --> H["Save to PostgreSQL"]
    D --> H
    H --> I["Cron checks daily"]
    I --> J["Send admin alerts"]
```

## Tech Stack

- Node.js
- Telegraf
- PostgreSQL
- node-cron
- ExcelJS
- dotenv

## Environment Variables

Create a local `.env` file based on `.env.example`.

```env
BOT_TOKEN=your_telegram_bot_token
ADMIN_ID=your_telegram_user_id
DATABASE_URL=your_postgres_connection_string
PORT=3000
```

## Installation

```bash
npm install
```

## Run Locally

```bash
npm start
```

## Database Model

The bot stores customer records in a single `customers` table:

- `id`
- `service`
- `name`
- `note`
- `start_date`
- `expiry_date`
- `monthly_remind`

## Security Notes

- Do not commit `.env` files or deployment secrets.
- Restrict bot usage by keeping `ADMIN_ID` private and correct.
- Use a secure PostgreSQL connection in production.
- Avoid publishing real customer data, exports, or screenshots containing personal information.

## Intellectual Property

Copyright belongs to the author.

This repository is shared publicly to present the project, its structure, and its workflow.
It is not published as open source for reuse, resale, redistribution, or commercial deployment.

## Roadmap Ideas

- multi-admin role support
- service configuration from database instead of hardcoded values
- audit log for edits and deletions
- safer export file handling
- deployment guide for Render / Railway / VPS
