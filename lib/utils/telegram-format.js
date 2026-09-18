function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function actionLabel(action) {
  const labels = {
    external_directory: 'Acceder a una carpeta fuera del proyecto',
    bash: 'Ejecutar un comando en la terminal',
    edit: 'Editar un archivo',
    write: 'Crear o sobrescribir un archivo',
    read: 'Leer un archivo',
    glob: 'Buscar archivos',
    grep: 'Buscar texto en archivos',
    webfetch: 'Pedir datos de internet',
    question: 'Hacer una pregunta'
  };

  return labels[action] || action || 'Hacer un cambio';
}

function metadataValue(metadata, keys) {
  if (!metadata) {
    return '';
  }

  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function formatExtraMetadata(metadata, skipKeys) {
  if (!metadata || typeof metadata !== 'object') {
    return '';
  }

  const skip = new Set(skipKeys);
  const bits = [];

  Object.keys(metadata).forEach((key) => {
    if (skip.has(key)) {
      return;
    }

    const value = metadata[key];
    if (value == null || value === '') {
      return;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      bits.push(`${key}: ${value}`);
      return;
    }

    try {
      bits.push(`${key}: ${JSON.stringify(value)}`);
    } catch (err) {
      bits.push(`${key}: [object]`);
    }
  });

  return bits.join('\n').slice(0, 800);
}

function formatPermissionHtml(permission) {
  const action = permission.action || permission.permission || '';
  const metadata = permission.metadata || {};
  const command = metadataValue(metadata, ['command', 'cmd', 'bash', 'input', 'script']);
  const tool = metadataValue(metadata, ['tool', 'name', 'title']);
  const description = metadataValue(metadata, ['description', 'message']);
  const targets = permission.resources || permission.patterns || [];

  const lines = [
    '<b>OpenCode pide permiso</b>',
    '',
    '<b>Qué quiere hacer</b>',
    escapeHtml(actionLabel(action))
  ];

  if (action && action !== actionLabel(action)) {
    lines.push(`<i>${escapeHtml(action)}</i>`);
  }

  if (tool) {
    lines.push('', '<b>Herramienta</b>', `<code>${escapeHtml(tool)}</code>`);
  }

  if (command) {
    lines.push('', '<b>Comando</b>', `<pre>${escapeHtml(command.slice(0, 1500))}</pre>`);
  }

  if (description && description !== command) {
    lines.push('', '<b>Detalle</b>', escapeHtml(description.slice(0, 500)));
  }

  const extraMeta = formatExtraMetadata(metadata, ['command', 'cmd', 'bash', 'input', 'script', 'tool', 'name', 'title', 'description', 'message']);
  if (extraMeta) {
    lines.push('', '<b>Más datos</b>', `<pre>${escapeHtml(extraMeta)}</pre>`);
  }

  if (targets.length > 0) {
    lines.push('', '<b>Rutas</b>');
    targets.slice(0, 10).forEach((item) => {
      lines.push(`• <code>${escapeHtml(item)}</code>`);
    });
    if (targets.length > 10) {
      lines.push(`• <i>… ${targets.length - 10} más</i>`);
    }
  }

  lines.push('', '¿Aceptas este cambio?');
  return lines.join('\n');
}

function markdownToTelegramHtml(text) {
  if (!text) {
    return '';
  }

  const chunks = String(text).split(/```[\w-]*\n?/);
  let html = '';

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (i % 2 === 1) {
      html += `<pre>${escapeHtml(chunk.replace(/\n+$/, ''))}</pre>`;
      continue;
    }

    html += escapeHtml(chunk)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
      .replace(/^- /gm, '• ');
  }

  return html.trim();
}

module.exports = {
  escapeHtml,
  actionLabel,
  formatPermissionHtml,
  markdownToTelegramHtml
};
