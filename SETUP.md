# Termly CLI + Telegram (OpenCode)

Guía de lo que hay ahora: **Telegram es el cliente** y **Termly CLI en el Mac/PC arranca OpenCode**. No usa la app mobile de Termly ni pinta el TUI.

```
Tú en Telegram  →  bot  →  termly start --telegram  →  opencode serve  →  respuesta a Telegram
```

Por ahora **solo OpenCode**. Claude Code y el resto de tools siguen yendo por `termly start` + app mobile.

---

## Qué es y qué no es

| | App Termly | Telegram (este modo) |
|---|---|---|
| Cliente | Emulador xterm | Chat (texto, botones, fotos) |
| Claude / Aider / etc. | Sí | No |
| OpenCode TUI | Sí (pantalla completa) | No: solo el diálogo |
| Cifrado de sesión Termly | AES + DH | El de Telegram |
| Plan / build | En el TUI | `/plan` `/build` |
| Permisos | En el TUI | Botones Aceptar / Rechazar |

OpenCode en TUI redibuja la pantalla. Telegram no puede mostrar eso. Aquí el CLI levanta `opencode serve` y habla por HTTP: prompts, agentes, modelos, sesiones y permisos.

---

## Requisitos

- Node.js 18+
- OpenCode instalado (`opencode --version`)
- Un bot de Telegram (token de [@BotFather](https://t.me/BotFather))
- Al menos un proveedor/modelo configurado en OpenCode

---

## Instalación y arranque

En este repo **no hace falta** el comando global `termly` (`zsh: command not found: termly`).

```bash
cd /ruta/al/termly-cli
npm install
```

Correr el modo Telegram:

```bash
node bin/cli.js start --telegram
```

Opcional, comando global:

```bash
npm link
termly start --telegram
```

Token del bot (una de estas):

```bash
termly config set telegramBotToken 123456:ABC...
# o
export TERMLY_TELEGRAM_BOT_TOKEN=123456:ABC...
# o
node bin/cli.js start --telegram --telegram-token 123456:ABC...
```

Ver config:

```bash
node bin/cli.js config
```

Claves útiles: `telegramBotToken`, `telegramChatId` (se guarda al emparejar).

---

## Emparejar el chat

1. Arranca el CLI en la carpeta del **proyecto** que quieres que OpenCode use.
2. Si es la primera vez, el CLI imprime un código `ABC-123`.
3. Ábrelo en Telegram y mándale ese código (o `/start ABC123`).
4. Ese chat queda autorizado. Otros chats se ignoran.

A partir de ahí, un mensaje normal es un prompt a OpenCode.

---

## Comandos de Telegram

Toca **/** en el chat. El bot registra el menú al arrancar.

| Comando | Qué hace |
|---|---|
| `/help` `/start` | Lista de comandos, modo y modelo actuales |
| `/plan` | Modo plan: analiza, **no edita** código |
| `/build` | Modo build: **implementa** cambios |
| `/plan tu idea` | Cambia a plan y manda ese prompt |
| `/build haz X` | Cambia a build y manda ese prompt |
| `/agents` | Agentes disponibles (plan, build, …) |
| `/model` | Lista modelos (botones; varios mensajes si hay muchos) |
| `/model vision` | Solo modelos que **ven imágenes** (👁) |
| `/model provider/id` | Fija el modelo, ej. `/model anthropic/claude-sonnet-4-5` |
| `/sessions` `/continue` | Lista conversaciones de OpenCode y las tocas para continuar |
| `/new` | Chat nuevo (pierde el hilo anterior) |
| `/abort` `/stop` | Cancela la tarea en curso |
| `/status` | Proyecto, modo, modelo (visión o solo texto), sesión |

Un mensaje **sin /** se envía al modo actual (`build` por defecto).

---

## Plan vs build

Igual que en el TUI de OpenCode:

- **plan** — piensa, propone, no toca archivos.
- **build** — escribe y ejecuta.

`/status` te dice en cuál estás.

---

## Modelos e imágenes

El archivo de una foto **sí llega** al Mac (carpeta inbox). Eso no implica que el modelo la **vea**.

- `opencode-go/minimax-m2.7` (y otros de solo texto) usan la tool `Read` y fallan con `.jpg`.
- Para capturas de pantalla hace falta un modelo **con visión**: Claude, GPT-4o, Gemini, etc.

```
/model vision
```

Elige uno con 👁 y **vuelve a mandar la foto**. `/status` indica `(ve imágenes)` o `(solo texto)`.

Si mandas una foto con un modelo sin visión, el bot avisa y no gasta un prompt inútil. Puedes mandar la foto **con caption** (`esta`, `qué ves aquí`); el caption es el prompt.

Documentos (PDF, etc.) también se aceptan; el modelo tiene que poder usarlos.

---

## Carpeta de adjuntos

Termly crea sola:

```
{proyecto}/.termly-inbox/
```

Ahí caen fotos y documentos de Telegram. OpenCode los lee desde el disco del proyecto. Ya está en `.gitignore` (`.termly-inbox`). No subas esa carpeta al repo.

Límite: **20 MB** por archivo (límite del Bot API).

---

## Permisos (Aceptar / Rechazar)

Cuando OpenCode quiere:

- salir del proyecto (`external_directory`)
- correr un comando (`bash`)
- editar / escribir archivos

Telegram muestra **qué quiere hacer**, el **comando** si viene en los metadatos, y las **rutas**. Botones:

- **Aceptar** — esta vez
- **Siempre** — no vuelvas a preguntar eso
- **Rechazar** — no lo hace

Hasta que toques un botón, OpenCode espera.

---

## Conversaciones (continuar un chat)

Al **reiniciar el CLI**, antes se creaba un chat nuevo y OpenCode decía que no tenía contexto.

Ahora:

- Al arrancar **reanuda el último chat** de ese proyecto.
- `/sessions` lista las conversaciones; toca una para continuar.
- `/new` crea una desde cero.

El id se guarda en config (`telegramOpenCodeSessionId`).

Importante: el “chat” es la **sesión de OpenCode**, no el historial visual de Telegram. Si cambias de proyecto (`cd` a otra carpeta y vuelves a arrancar), las sesiones son las de **esa** carpeta.

---

## Cómo correrlo día a día

```bash
cd /ruta/de/tu/proyecto
node /ruta/a/termly-cli/bin/cli.js start --telegram
```

El working directory es el proyecto. OpenCode trabaja ahí. Si le pides `ls` de una carpeta hermana (`experimentalLabs/stealthis`), pedirá permiso `external_directory`.

Deja el proceso del CLI vivo. Ctrl+C lo apaga. Tras un cambio de código, **reinicia** el CLI para cargar la versión nueva.

---

## Consideraciones y límites

1. **Un chat de Telegram por bot.** El primero que empareja queda en `telegramChatId`. Para cambiar: `termly config set telegramChatId <id>` o borra esa clave y vuelve a emparejar.
2. **Un dispositivo / un operador.** No es un bot público. Quien tenga el código o el chat guardado controla OpenCode en tu Mac.
3. **Permisos auto:** ya no se aprueban solos. Tú aceptas o rechazas.
4. **TUI:** no vas a ver paneles, mouse ni el layout de OpenCode. Solo texto + botones.
5. **Herramientas en vivo:** el bot manda la respuesta final. Los `pwd` / `ls` intermedios del TUI no se retransmiten uno a uno (salvo lo que OpenCode ponga en el texto final o en el permiso).
6. **Cola:** si mandas otro prompt mientras trabaja, entra en cola.
7. **URLs del servidor Termly** (`api.termly.dev`) no aplican a este modo. Telegram no pasa por el relay de Termly.
8. **Windows:** OpenCode se lanza vía `cmd.exe` igual que el resto del CLI.
9. **Debug:** `node bin/cli.js start --telegram --debug` o `DEBUG=1`.

---

## Problemas frecuentes

**`termly: command not found`**  
Usa `node bin/cli.js start --telegram` o `npm link`.

**Aceptar no hacía nada**  
El poll de Telegram se bloqueaba esperando a OpenCode. Eso ya está corregido: los botones se procesan en paralelo. Reinicia el CLI si sigues con una versión vieja.

**OpenCode dice que es una conversación nueva**  
Reiniciaste el CLI y se creaba `/new` implícito. Ahora reanuda la última. Si no, `/sessions`.

**“No veo ninguna imagen”**  
1. ¿La foto iba **en el mismo mensaje** que el texto?  
2. ¿El modelo tiene visión? `/model vision` y reenvía la foto.  
3. Mira que el archivo aparezca en `.termly-inbox/`.

**Lista de modelos cortada**  
Ya no se limita a 8. `/model` manda todos en tandas de 20 botones.

**Session already running in this directory**  
`termly stop` o el session id que imprime el error. O `termly cleanup` si el proceso murió.

---

## Archivos del modo Telegram

| Archivo | Rol |
|---|---|
| `bin/cli.js` | Flag `--telegram` / `--telegram-token` |
| `lib/commands/start.js` | Desvía a Telegram si hay `--telegram` |
| `lib/commands/start-telegram.js` | Flujo: pairing, comandos, cola, inbox |
| `lib/ai-tools/opencode-client.js` | `opencode serve`, sesiones, modelos, permisos, visión |
| `lib/network/telegram-bot.js` | Poll, menú `/`, botones, fotos/docs |
| `lib/utils/telegram-format.js` | HTML de permisos y respuestas |
| `lib/config/constants.js` | Timeouts, inbox, lista de comandos del bot |
| `~/.termly/config.json` | Token, chat id, última sesión OpenCode |

---

## Comandos CLI relacionados

```bash
node bin/cli.js start --telegram
node bin/cli.js config
node bin/cli.js config set telegramBotToken <token>
node bin/cli.js status
node bin/cli.js stop
node bin/cli.js cleanup
```

El `start` clásico (QR + app mobile) no cambia:

```bash
node bin/cli.js start
node bin/cli.js start --ai opencode
```
