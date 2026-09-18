const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const axios = require('axios').default || require('axios');
const logger = require('../utils/logger');
const {
  TELEGRAM_OPENCODE_HOST,
  TELEGRAM_OPENCODE_PORT,
  TELEGRAM_OPENCODE_HEALTH_TIMEOUT,
  TELEGRAM_OPENCODE_PROMPT_TIMEOUT,
  TELEGRAM_DEFAULT_AGENT
} = require('../config/constants');

class OpenCodeClient {
  constructor(command, workingDir) {
    this.command = command || 'opencode';
    this.workingDir = workingDir;
    this.process = null;
    this.baseUrl = null;
    this.sessionId = null;
    this.sessionInfo = null;
    this.http = null;
    this.eventStream = null;
    this.closed = false;
    this.agent = TELEGRAM_DEFAULT_AGENT;
    this.model = null;
    this.modelVision = null;
    this.onPermissionCallback = null;
  }

  async start() {
    const args = [
      'serve',
      '--hostname', TELEGRAM_OPENCODE_HOST,
      '--port', String(TELEGRAM_OPENCODE_PORT)
    ];

    logger.info('Starting OpenCode server...');
    logger.debug(`Command: ${this.command} ${args.join(' ')}`);

    const spawnCommand = os.platform() === 'win32' ? 'cmd.exe' : this.command;
    const spawnArgs = os.platform() === 'win32'
      ? ['/c', this.command, ...args]
      : args;

    this.process = spawn(spawnCommand, spawnArgs, {
      cwd: this.workingDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    const onChunk = (chunk) => {
      const text = chunk.toString();
      output += text;
      text.split('\n').forEach((line) => {
        const trimmed = line.trim();
        if (trimmed) {
          logger.debug(`OpenCode: ${trimmed}`);
        }
      });
    };

    this.process.stdout.on('data', onChunk);
    this.process.stderr.on('data', onChunk);

    this.process.on('exit', (code) => {
      this.process = null;
      if (!this.closed) {
        logger.error(`OpenCode server exited with code ${code}`);
      }
    });

    this.baseUrl = await this.waitForServer(() => output);
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: TELEGRAM_OPENCODE_PROMPT_TIMEOUT,
      headers: { 'Content-Type': 'application/json' }
    });

    this.listenForEvents();

    logger.success(`OpenCode server ready at ${this.baseUrl}`);
    return this.baseUrl;
  }

  async waitForServer(getOutput) {
    const started = Date.now();

    while (Date.now() - started < TELEGRAM_OPENCODE_HEALTH_TIMEOUT) {
      if (!this.process) {
        throw new Error('OpenCode server failed to start');
      }

      const match = getOutput().match(/listening on (https?:\/\/\S+)/i);
      const url = match ? match[1].replace(/[.,;]+$/, '') : null;

      if (url) {
        try {
          const health = await axios.get(`${url}/global/health`, { timeout: 1000 });
          if (health.data && health.data.healthy) {
            return url;
          }
        } catch (err) {
          logger.debug(`Waiting for OpenCode health: ${err.message}`);
        }
      }

      await delay(250);
    }

    throw new Error('Timed out waiting for OpenCode server');
  }

  listenForEvents() {
    const connect = async () => {
      if (this.closed) {
        return;
      }

      try {
        const response = await axios.get(`${this.baseUrl}/event`, {
          responseType: 'stream',
          timeout: 0
        });

        this.eventStream = response.data;
        let buffer = '';

        this.eventStream.on('data', (chunk) => {
          buffer += chunk.toString();
          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';

          frames.forEach((frame) => {
            const line = frame.split('\n').find((entry) => entry.startsWith('data:'));
            if (!line) {
              return;
            }

            try {
              const event = JSON.parse(line.slice(5).trim());
              this.handleEvent(event);
            } catch (err) {
              logger.debug(`Failed to parse OpenCode event: ${err.message}`);
            }
          });
        });

        this.eventStream.on('end', () => {
          this.eventStream = null;
          if (!this.closed) {
            logger.debug('OpenCode event stream ended, reconnecting');
            setTimeout(connect, 1000);
          }
        });

        this.eventStream.on('error', (err) => {
          logger.debug(`OpenCode event stream error: ${err.message}`);
        });
      } catch (err) {
        if (!this.closed) {
          logger.debug(`OpenCode event subscribe failed: ${err.message}`);
          setTimeout(connect, 2000);
        }
      }
    };

    connect();
  }

  handleEvent(event) {
    if (!event || !event.type) {
      return;
    }

    logger.debug(`OpenCode event: ${event.type}`);

    if (event.type === 'permission.asked') {
      this.emitPermission({
        version: 1,
        ...(event.properties || {})
      });
      return;
    }

    if (event.type === 'permission.v2.asked') {
      this.emitPermission({
        version: 2,
        ...(event.data || {})
      });
    }
  }

  onPermission(callback) {
    this.onPermissionCallback = callback;
  }

  emitPermission(permission) {
    if (!permission || !permission.id) {
      return;
    }

    logger.info(`OpenCode permission: ${permission.action || permission.permission || permission.id}`);
    if (permission.metadata) {
      logger.debug(`Permission metadata: ${JSON.stringify(permission.metadata)}`);
    }

    if (this.onPermissionCallback) {
      Promise.resolve(this.onPermissionCallback(permission)).catch((err) => {
        logger.debug(`Permission notify failed: ${err.message}`);
      });
    }
  }

  async replyPermission(permission, reply) {
    if (!permission || !permission.id) {
      throw new Error('Missing permission id');
    }

    const allowed = ['once', 'always', 'reject'];
    if (!allowed.includes(reply)) {
      throw new Error(`Invalid permission reply: ${reply}`);
    }

    if (permission.version === 2) {
      await this.http.post(`/permission/${permission.id}/reply`, { reply });
      return;
    }

    const sessionId = permission.sessionID || this.sessionId;
    await this.http.post(`/session/${sessionId}/permissions/${permission.id}`, {
      response: reply
    });
  }

  async createSession(title) {
    const response = await this.http.post('/session', {
      title: title || 'Termly Telegram'
    });

    this.sessionId = response.data.id;
    this.sessionInfo = response.data;
    logger.info(`OpenCode session: ${this.sessionId}`);
    return response.data;
  }

  async listSessions() {
    const response = await this.http.get('/session');
    const sessions = Array.isArray(response.data) ? response.data : [];

    return sessions.sort((a, b) => {
      return (b.time && b.time.updated ? b.time.updated : 0)
        - (a.time && a.time.updated ? a.time.updated : 0);
    });
  }

  isSameProject(session) {
    if (!session || !session.directory) {
      return false;
    }

    return path.resolve(session.directory) === path.resolve(this.workingDir);
  }

  async listProjectSessions() {
    const sessions = await this.listSessions();
    const project = sessions.filter((session) => this.isSameProject(session));
    return project.length > 0 ? project : sessions;
  }

  async useSession(sessionId) {
    const response = await this.http.get(`/session/${sessionId}`);
    this.sessionId = response.data.id;
    this.sessionInfo = response.data;
    logger.info(`OpenCode session resumed: ${this.sessionId}`);
    return response.data;
  }

  async resumeOrCreate(preferredId) {
    const sessions = await this.listProjectSessions().catch(() => []);

    if (preferredId) {
      const preferred = sessions.find((session) => session.id === preferredId);
      if (preferred) {
        return this.useSession(preferred.id);
      }
    }

    if (sessions.length > 0) {
      return this.useSession(sessions[0].id);
    }

    return this.createSession('Termly Telegram');
  }

  sessionTitle(session) {
    const info = session || this.sessionInfo;
    if (!info) {
      return this.sessionId || 'OpenCode';
    }

    return info.title || info.slug || info.id;
  }

  async sendPrompt(text, files) {
    if (!this.sessionId) {
      throw new Error('OpenCode session is not ready');
    }

    const attachments = Array.isArray(files) ? files : [];
    logger.debug(`Sending prompt to OpenCode as ${this.agent} (${text.length} chars, ${attachments.length} files)`);

    const parts = [{ type: 'text', text }];

    attachments.forEach((file) => {
      parts.push(toOpenCodeFilePart(file));
    });

    const body = {
      agent: this.agent,
      parts
    };

    if (this.model) {
      body.model = {
        providerID: this.model.providerID,
        modelID: this.model.id
      };
    }

    const response = await this.http.post(`/session/${this.sessionId}/message`, body);

    return extractAssistantText(response.data);
  }

  async abort() {
    if (!this.sessionId) {
      return;
    }

    try {
      await this.http.post(`/session/${this.sessionId}/abort`);
    } catch (err) {
      logger.debug(`Abort failed: ${err.message}`);
    }
  }

  async newSession() {
    await this.abort();
    return this.createSession('Termly Telegram');
  }

  async listAgents() {
    const response = await this.http.get('/agent');
    const agents = Array.isArray(response.data) ? response.data : [];

    return agents.filter((agent) => {
      if (!agent || agent.hidden) {
        return false;
      }

      return agent.mode === 'primary' || agent.mode === 'all';
    });
  }

  async setAgent(name) {
    const requested = String(name || '').trim().toLowerCase();
    if (!requested) {
      throw new Error('Agent name is required');
    }

    const agents = await this.listAgents().catch(() => []);
    const match = agents.find((agent) => agent.name.toLowerCase() === requested)
      || (['plan', 'build'].includes(requested) ? { name: requested } : null);

    if (!match) {
      const available = agents.map((agent) => agent.name).join(', ') || 'plan, build';
      throw new Error(`Unknown agent "${requested}". Available: ${available}`);
    }

    this.agent = match.name;

    try {
      await this.http.post(`/api/session/${this.sessionId}/agent`, {
        agent: this.agent
      });
    } catch (err) {
      logger.debug(`Session agent switch API failed, using prompt agent: ${err.message}`);
    }

    logger.info(`OpenCode agent: ${this.agent}`);
    return match;
  }

  async listModels() {
    const response = await this.http.get('/provider');
    const payload = response.data || {};
    const connected = new Set(payload.connected || []);
    const models = [];

    (payload.all || []).forEach((provider) => {
      if (connected.size > 0 && !connected.has(provider.id)) {
        return;
      }

      Object.keys(provider.models || {}).forEach((modelId) => {
        const info = provider.models[modelId] || {};
        models.push({
          providerID: provider.id,
          providerName: provider.name || provider.id,
          id: modelId,
          name: info.name || modelId,
          vision: hasVision(info)
        });
      });
    });

    return {
      models,
      defaults: payload.default || {}
    };
  }

  async setModel(input) {
    const requested = String(input || '').trim();
    const slash = requested.lastIndexOf('/');
    if (slash <= 0) {
      throw new Error('Usa /model provider/id  (ejemplo: /model anthropic/claude-sonnet-4-5)');
    }

    const providerID = requested.slice(0, slash);
    const id = requested.slice(slash + 1);
    const { models } = await this.listModels();
    const match = models.find((model) => {
      return model.providerID === providerID && model.id === id;
    }) || models.find((model) => {
      return `${model.providerID}/${model.id}`.toLowerCase() === requested.toLowerCase();
    });

    if (!match) {
      throw new Error(`Modelo no encontrado: ${requested}. Usa /model para ver la lista.`);
    }

    this.model = { providerID: match.providerID, id: match.id };
    this.modelVision = !!match.vision;

    try {
      await this.http.post(`/api/session/${this.sessionId}/model`, {
        model: { providerID: match.providerID, id: match.id }
      });
    } catch (err) {
      logger.debug(`Session model switch API failed, using prompt model: ${err.message}`);
    }

    logger.info(`OpenCode model: ${this.formatModel()}`);
    return match;
  }

  formatModel() {
    if (!this.model) {
      return 'default';
    }

    return `${this.model.providerID}/${this.model.id}`;
  }

  async resolveCurrentModel() {
    const { models, defaults } = await this.listModels();

    if (this.model) {
      return models.find((model) => {
        return model.providerID === this.model.providerID && model.id === this.model.id;
      }) || null;
    }

    const entries = Object.entries(defaults || {});
    for (const [providerID, id] of entries) {
      const match = models.find((model) => model.providerID === providerID && model.id === id);
      if (match) {
        this.model = { providerID: match.providerID, id: match.id };
        this.modelVision = !!match.vision;
        return match;
      }
    }

    return null;
  }

  async modelSupportsVision() {
    const current = await this.resolveCurrentModel();
    if (current) {
      return !!current.vision;
    }

    return this.modelVision === true;
  }

  describeAgent(name) {
    if (name === 'plan') {
      return 'analiza y propone, no edita archivos';
    }

    if (name === 'build') {
      return 'implementa cambios en el código';
    }

    return 'agente de OpenCode';
  }

  getStatus() {
    return {
      baseUrl: this.baseUrl,
      sessionId: this.sessionId,
      workingDir: this.workingDir,
      pid: this.process ? this.process.pid : null,
      agent: this.agent,
      model: this.formatModel(),
      vision: this.modelVision === true
    };
  }

  close() {
    this.closed = true;

    if (this.eventStream) {
      this.eventStream.destroy();
      this.eventStream = null;
    }

    if (this.process) {
      logger.debug('Stopping OpenCode server');
      this.process.kill();
      this.process = null;
    }
  }
}

function hasVision(info) {
  const caps = info && info.capabilities ? info.capabilities : {};
  if (caps.input && caps.input.image) {
    return true;
  }

  return !!caps.attachment;
}

function toOpenCodeFilePart(file) {
  const mime = file.mime || 'application/octet-stream';
  const isImage = mime.startsWith('image/');
  let url = pathToFileURL(file.path).href;

  if (isImage) {
    const buffer = fs.readFileSync(file.path);
    url = `data:${mime};base64,${buffer.toString('base64')}`;
  }

  return {
    type: 'file',
    mime,
    filename: file.filename,
    url
  };
}

function extractAssistantText(payload) {
  const parts = payload && payload.parts ? payload.parts : [];
  const texts = parts
    .filter((part) => part && part.type === 'text' && part.text && !part.synthetic)
    .map((part) => part.text.trim())
    .filter(Boolean);

  if (texts.length > 0) {
    return texts.join('\n\n');
  }

  const tools = parts
    .filter((part) => part && part.type === 'tool' && part.tool)
    .map((part) => part.tool);

  if (tools.length > 0) {
    return `OpenCode finished. Tools used: ${tools.join(', ')}`;
  }

  return 'OpenCode finished with no text reply.';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = OpenCodeClient;
