# Invoice Tracker & Books (mockup)

Static site, no build step. Built to Build Spec v2 (South African CC: ZAR, 15% VAT, invoice or payments basis, bi-monthly SARS periods).

## Deploy to Vercel
- Drag this folder onto vercel.com/new, or run `vercel` inside it.
- Framework preset: **Other**. No build command, output directory is the folder root.

## Data
- Everything is stored in the browser's localStorage on the device that opens the site. Nothing is sent to a server.
- Use **Settings → Backup** to download a JSON backup and restore it on another device or browser.
- Anyone with the URL gets their own empty copy. Add Vercel password protection (Project → Settings → Deployment Protection) if the URL shouldn't be public.

## What's simulated
- Reminder and invoice emails are logged, not sent (test mode addresses them to the owner).
- No Google Sheet sync, no PDF storage, and the CA review opens inside the app rather than from an emailed link.

## Files
- `index.html` – the whole app (styles, rules, storage and screens in one file)



