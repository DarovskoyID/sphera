<p align="center">
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/Vite-7-646CFF?style=for-the-badge&logo=vite&logoColor=white" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-3-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white" />
  <img src="https://img.shields.io/badge/Supabase-Backend-3FCF8E?style=for-the-badge&logo=supabase&logoColor=white" />
</p>

# ⚡ Сфера

**Real-time messenger with guilds, voice calls, and rich chat features** — inspired by Discord, built with React + TypeScript.

---

## ✨ Features

| Category | Details |
|----------|---------|
| **Messaging** | Direct messages, group chats, file attachments, emoji & sticker picker |
| **Guilds** | Server-like guilds with text channels, voice rooms, roles & permissions |
| **Voice Calls** | 1-on-1 and guild voice rooms with incoming call modal |
| **Auth** | Sign up / sign in with Supabase authentication |
| **i18n** | 7 languages — English, Russian, German, French, Spanish, Portuguese, Chinese |
| **Themes** | Customizable appearance & settings panel |
| **Responsive** | Full mobile support with adaptive layout |
| **Bots** | Bot accounts registered by Сфероник, node editor, Python/C++/Rust SDKs — see [docs/BOTS.md](docs/BOTS.md) |

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** 18+
- **npm** or **yarn**

### Installation

```bash
# Clone the repository
git clone https://github.com/DarovskoyID/sfera-all.git
cd sfera-all

# Install dependencies
npm install

# Start the dev server
npm run dev
```

The app will be available at `http://localhost:5173`.

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with HMR |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Type-check without emitting |

---

## 🏗 Tech Stack

- **Frontend** — React 18, TypeScript, Tailwind CSS
- **Build** — Vite 7
- **Backend** — Supabase (auth, database, realtime)
- **Icons** — Lucide React

---

## 📁 Project Structure

```
src/
├── components/       # UI components (Chat, Guild, Auth, Calls, etc.)
├── config/           # Server & network configuration
├── context/          # React context (AppContext)
├── data/             # Mock data & emoji sets
├── i18n/             # Translations (en, ru, de, fr, es, pt, zh)
├── types/            # TypeScript interfaces
├── utils/            # Helper functions
├── App.tsx           # Root component
└── main.tsx          # Entry point
```

---

## 🌍 Supported Languages

🇬🇧 English · 🇷🇺 Русский · 🇩🇪 Deutsch · 🇫🇷 Français · 🇪🇸 Español · 🇧🇷 Português · 🇨🇳 中文

---

## 📄 License

This project is private.
