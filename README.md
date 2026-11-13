
# 🤖 Ollama Minecraft Bot

> **⚠️**  This project was completely vibecoded. Feel free to make whatever changes you want to it for your own use, but please do not repost this repository.

An AI-powered **Minecraft 1.20.1** survival and PvP bot powered by [Mineflayer](https://github.com/PrismarineJS/mineflayer) and [Ollama](https://ollama.com/). Talk to the bot directly in in-game chat to ask questions, have it perform tasks using local LLM tool-calling, or challenge it to a 1v1 PvP duel!

> **⚠️ Version Requirement:** This bot **only supports Minecraft Java Edition 1.20.1**.

## ✨ Features

* **Local AI Brain (Ollama):** Connects to a locally running Ollama instance (defaults to `llama3.1`) with rolling chat memory and live world awareness (health, hunger, coordinates, inventory, nearby players, and hostile mobs).
* **Tool Calling & Actions:** Uses structured tool calls to interact with the world, gather blocks, equip gear, and complete tasks in the background.
* **Advanced PvP Duel Mode:** Type `pvp` in chat to start a 1v1 duel. The bot automatically:
  * Equips its best armor, weapon, and shield.
  * Pathfinds to close distance and switches to manual combat up close.
  * Strafes, maintains spacing, and performs **W-taps** for extra knockback.
  * Times weapon cooldowns (sword vs. axe) and jumps to land **critical hits**.
  * Raises its shield between swings and retreats to eat golden apples/food when low on health.
* **Survival Automation:** Automatically eats when hungry (`autoEatBelow`) and sweeps inventory to equip the best available armor.
* **Smart Chat Handling:** Sanitizes formatting, splits long AI responses across multiple messages to respect Minecraft's 256-character limit, and rate-limits messages to prevent server spam kicks.
* **Auto-Reconnect:** Built-in exponential backoff automatically reconnects the bot if it gets disconnected or kicked.

## 🔗 Required Downloads & Links

Before setting up the bot, download and install everything you will need using the links below:

1. **Visual Studio Code (Recommended Code Editor):**
   * Download VS Code: <https://code.visualstudio.com/>
2. **Node.js (v18.0.0 or higher; v22+ recommended):**
   * Download Node.js: <https://nodejs.org/en/download>
3. **Ollama (Local AI Runner):**
   * Download Ollama (Windows, macOS, Linux): <https://ollama.com/download>
   * Supported Tool-Calling Models: [Llama 3.1](https://ollama.com/library/llama3.1) or [Qwen 2.5](https://ollama.com/library/qwen2.5)
4. **Minecraft Java Edition 1.20.1:**
   * Official Minecraft Launcher: <https://www.minecraft.net/en-us/download> *(Make sure to select **Release 1.20.1** in your launcher installations)*
   * Optional Dedicated 1.20.1 Server Software (if not using Singleplayer "Open to LAN"): [PaperMC 1.20.1](https://papermc.io/downloads/all) or [Vanilla 1.20.1 Server](https://mcversions.net/download/1.20.1)

### 📦 Powered by Mineflayer

This bot is powered by [Mineflayer](https://github.com/PrismarineJS/mineflayer). To install it along with all required dependencies, run:

```bash
npm install
```

## 🚀 Installation & Setup

### 1. Download the Project Files

Click the green **Code** button at the top of this GitHub page, click **Download ZIP**, and extract the folder. Then, open the folder inside **VS Code**.

### 2. Install Dependencies

Open the integrated terminal in VS Code (`Ctrl + ~` on Windows/Linux or `Cmd + ~` on Mac) and run:

```bash
npm install
```

*(Note: Ensure you also have your `package.json` and `tools.js` files present in the root directory alongside `index.js`, `bot.js`, `brain.js`, `duel.js`, and `config.json`.)*

### 3. Install & Start Ollama

1. Install Ollama from [ollama.com/download](https://ollama.com/download).
2. Make sure the Ollama app/service is running in the background.
3. Open your terminal and pull a model that supports **tool calling** (such as `llama3.1` or `qwen2.5`):

```bash
ollama pull llama3.1
```

### 4. Configure the Bot

Open `config.json` in VS Code and adjust the settings to match your Minecraft 1.20.1 server and Ollama setup.

* **Changing the Name & Port:** You can easily change the bot's in-game name and server port just by replacing the letters and numbers for `"username"` and `"port"` in `config.json` (for example, changing `"OllamaBot"` to `"MyBot"` or changing `25565` to your LAN/server port number). Keep `"version"` set to `"1.20.1"`.

```json
{
  "minecraft": {
    "host": "localhost",
    "port": 25565,
    "username": "OllamaBot",
    "auth": "offline",
    "version": "1.20.1"
  },
  "ollama": {
    "host": "http://127.0.0.1:11434",
    "model": "llama3.1",
    "temperature": 0.5,
    "numCtx": 8192,
    "maxToolRounds": 4,
    "requestTimeoutMs": 90000,
    "keepAlive": "30m"
  },
  "chat": {
    "maxLength": 256,
    "maxChunks": 3,
    "historySize": 10,
    "sendDelayMs": 1200,
    "requireMention": false,
    "allowedPlayers": [],
    "greeting": "Hi! I'm online. Talk to me in chat and tell me what to do."
  },
  "bot": {
    "autoEatBelow": 15,
    "canDig": true,
    "allowAttackPlayers": false,
    "mineSearchRadius": 48,
    "attackSearchRadius": 32,
    "equipIntervalMs": 60000
  },
  "reconnect": {
    "baseDelayMs": 5000,
    "maxDelayMs": 60000
  }
}
```

#### Environment Variable Overrides (Optional)

You can also override key connection settings directly from your terminal without editing `config.json`:
* `MC_HOST` (e.g., `play.example.com`)
* `MC_PORT` (e.g., `25565`)
* `MC_USERNAME` (e.g., `OllamaBot`)
* `OLLAMA_HOST` (e.g., `http://127.0.0.1:11434`)
* `OLLAMA_MODEL` (e.g., `llama3.1`)

### 5. Run the Bot

Start your Minecraft 1.20.1 world (open it to LAN or start your 1.20.1 server), then run the bot in your terminal:

```bash
node index.js
```

## 🎮 In-Game Usage & Commands

Once the bot spawns into your 1.20.1 world, you can interact with it directly through the in-game chat:

### General Chat & AI Tasks

Just type normally in chat (or include the bot's username if `requireMention` is set to `true` in `config.json`):
* *"Hey OllamaBot, what's in your inventory?"*
* *"Go mine some oak logs for me."*
* *"Come over to me."*

### PvP Duel Commands

* **Start a duel:** Type `pvp`, `!pvp`, or `pvp me` in chat.
* **Stop a duel:** Type `stop`, `pvp stop`, `stop pvp`, `pvp off`, `peace`, `yield`, or `gg`.

## 📁 Project Structure

```text
├── index.js          # Entry point, config loader, and auto-reconnect manager
├── bot.js            # Mineflayer initialization, plugin loading, auto-eat, auto-armor, and chat queue
├── brain.js          # Ollama API integration, prompt builder, chat memory, and tool-calling loop
├── duel.js           # Dedicated 1v1 PvP combat state machine (crits, W-tapping, strafing, shielding)
├── tools.js          # World interaction tools exposed to the LLM
├── config.json       # Bot, Minecraft, and Ollama configuration
├── package.json      # Project metadata and dependencies
└── package-lock.json # Locked dependency tree
```

## 🔧 Troubleshooting

* **Bot disconnects immediately or fails protocol check**
  Make sure your Minecraft server or LAN world is running **version 1.20.1**, as other versions are not supported.
* **`My brain (Ollama) isn't reachable right now.`**
  Make sure Ollama is running in the background (`ollama serve`) and matches the `ollama.host` URL in `config.json`.
* **`The model "..." can't use tools.`**
  Not all Ollama models support function/tool calling. Switch to [Llama 3.1](https://ollama.com/library/llama3.1) or [Qwen 2.5](https://ollama.com/library/qwen2.5) in `config.json`.
* **Bot fails to join the server (`Invalid session` / `Failed to verify username`)**
  If `minecraft.auth` is set to `"offline"`, make sure your Minecraft server has `online-mode=false` in its `server.properties` file (or Open to LAN).
