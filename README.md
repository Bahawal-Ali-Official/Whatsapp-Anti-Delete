# 🕵️ WhatsApp Spy & Logger Bot (Single File)

A lightweight, single-file WhatsApp bot designed to **log deleted and edited messages**. If someone deletes a message in a chat or group, this bot catches it and sends the original content (Text, Image, Video, Voice Note) to your private chat.

It comes with a built-in **Web QR Code**, making it easy to deploy on platforms like **Render**, Replit, or Heroku.

---

## ✨ Features

- **🗑️ Anti-Delete (Deleted Message Log):** - Detects when someone uses "Delete for Everyone".
  - Instantly forwards the **deleted text** or **media** (Photo/Video/Audio) to the Owner's DM.
  - Tells you exactly **who** deleted it, **where** (Group/Private), and **when**.

- **✏️ Anti-Edit (Edited Message Log):**
  - Detects when a message is edited.
  - Shows the **Original Message** vs the **New Message** side-by-side.

- **🌐 Web QR Code:**
  - No need to view QR codes in the terminal console.
  - Generates a website link to scan the QR code easily (Perfect for Cloud Deployment).

- **⚡ Lightweight:** - Runs entirely on a single file (`index.js`).
  - Fast and low memory usage.

---

## 🛠️ Installation & Setup (PC/Laptop)

1.  **Download the Code**
    Create a folder and put your `index.js` and `package.json` inside it.

2.  **Install Dependencies**
    Open your terminal/cmd in that folder and run:
    ```bash
    npm install @whiskeysockets/baileys @hapi/boom pino express qrcode
    ```

3.  **Configure Owner Number**
    Open `index.js` and find this line:
    ```javascript
    const OWNER_JID = '923001234567@s.whatsapp.net'; // Replace with YOUR number
    ```
    *Make sure to use your country code without `+`.*

4.  **Start the Bot**
    ```bash
    node index.js
    ```

5.  **Scan QR**
    Open `http://localhost:3000` in your browser and scan the code.

---

## ☁️ Deployment Guide (Render.com)

This bot is ready for Render. Follow these steps:

1.  **Upload to GitHub:** Upload your `index.js` and `package.json` to a GitHub repository.
2.  **Go to Render:** Create a **New Web Service**.
3.  **Connect Repo:** Select your GitHub repository.
4.  **Settings:**
    - **Runtime:** Node
    - **Build Command:** `npm install`
    - **Start Command:** `node index.js`
5.  **Deploy:** Click "Create Web Service".
6.  **Scan:** Once deployed, open the **Render URL** (e.g., `https://your-app.onrender.com`) to see the QR code and scan it.

---

## 📦 Required `package.json`

Ensure your `package.json` looks like this for Render to work correctly:

```json
{
  "name": "whatsapp-logger-bot",
  "version": "1.0.0",
  "description": "WhatsApp Deleted Message Logger",
  "main": "index.js",
  "type": "module",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "@hapi/boom": "^10.0.1",
    "@whiskeysockets/baileys": "^6.7.2",
    "express": "^4.19.2",
    "pino": "^9.1.0",
    "qrcode": "^1.5.3"
  }
}
