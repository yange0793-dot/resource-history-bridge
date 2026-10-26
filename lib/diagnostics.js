'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TOP_LEVEL_KEYS = ['model', 'input', 'messages', 'instructions', 'system', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'store', 'reasoning', 'reasoning_effort', 'thinking', 'output_config', 'text', 'response_format', 'max_tokens', 'max_output_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'previous_response_id', 'conversation', 'metadata', 'user', 'service_tier', 'truncation', 'include', 'stop', 'prompt_cache_key', 'prompt_cache_retention', 'safety_identifier'];
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function']);
const ITEM_TYPES = new Set(['message', 'reasoning', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'additional_tools', 'item_reference', 'tool_use', 'server_tool_use', 'tool_result', 'text', 'input_text', 'output_text', 'input_image', 'image', 'image_url', 'document', 'thinking', 'redacted_thinking']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const HEADER_NAMES = ['x-request-id', 'request-id', 'x-ms-request-id', 'apim-request-id', 'x-correlation-id', 'x-ms-correlation-request-id', 'x-ms-client-request-id', 'traceparent', 'x-amzn-trace-id'];
const CATEGORIES = new Set(['none', 'terminal', 'transient', 'resource', 'projection', 'encrypted', 'authentication', 'permission', 'content_filter', 'request_schema', 'request_error', 'network', 'transport', 'cancelled', 'unknown']);
const REASONS = new Set(['downstream_committed', 'output_started', 'unknown_output', 'cancelled', 'authentication', 'permission', 'content_filter', 'azure_resource_mismatch', 'native_history_recovery', 'request_schema', 'request_error', 'upstream_error', 'pre_output_connection_failure', 'empty_response_failed', 'empty_response_completed', 'unclassified_error', 'not_a_retryable_failure', 'not_retryable', 'deadline_expired', 'total_attempt_budget', 'transient_attempt_budget', 'resource_attempt_budget', 'projection_attempt_budget', 'retry_delay_exceeds_deadline', 'retry_scheduled', 'unsupported_history_mode', 'invalid_body', 'server_history_reference', 'explicit_history_required', 'invalid_history_item', 'invalid_item_id', 'item_reference', 'unsupported_item_id', 'invalid_tool_pair', 'no_supported_item_ids', 'projection_validation_failed', 'projection_rejected', 'projection_endpoint', 'validated_generic_400_projection', 'completed', 'client_closed', 'aborted', 'invalid_encrypted_content', 'encrypted_attempt_budget', 'no_encrypted_reasoning', 'empty_projected_input', 'unsupported_encrypted_history']);
const ERROR_CODES = new Set(['authentication_error', 'authentication_failed', 'invalid_api_key', 'missing_api_key', 'invalid_token', 'expired_token', 'token_expired', 'invalid_credentials', 'permission_error', 'permission_denied', 'access_denied', 'forbidden', 'insufficient_permissions', 'not_authorized', 'content_filter', 'content_filter_error', 'content_policy_violation', 'invalid_json', 'invalid_schema', 'schema_validation_error', 'invalid_parameter', 'invalid_parameters', 'invalid_argument', 'missing_required_parameter', 'unknown_parameter', 'unsupported_parameter', 'invalid_type', 'invalid_value', 'invalid_function_parameters', 'invalid_tool_schema', 'context_length_exceeded', 'max_tokens_exceeded', 'request_too_large', 'input_too_long', 'unsupported_model', 'model_not_found', 'invalid_request_error', 'bad_request', 'bad_request_error', 'invalid_resource', 'server_error', 'internal_server_error', 'internal_error', 'upstream_error', 'upstream_failure', 'upstream_unavailable', 'upstream_timeout', 'rate_limit_error', 'rate_limit_exceeded', 'too_many_requests', 'overloaded_error', 'overloaded', 'service_unavailable', 'temporarily_unavailable', 'timeout_error', 'request_timeout', 'api_error', 'econnrefused', 'econnreset', 'epipe', 'etimedout', 'ehostunreach', 'enetunreach', 'enotfound', 'eai_again', 'und_err_connect_timeout', 'und_err_socket', 'und_err_headers_timeout', 'und_err_body_timeout', 'abort_err', 'aborterror', 'invalid_encrypted_content']);
const EVENT_TYPES = new Set(['request', 'request_start', 'request_received', 'attempt', 'attempt_start', 'attempt_result', 'attempt_success', 'attempt_failure', 'upstream_response', 'upstream_error', 'response', 'response_error', 'recovery', 'retry', 'retry_scheduled', 'retry_stopped', 'projection', 'projection_result', 'projection_rejected', 'complete', 'completed', 'request_complete', 'request_end', 'request_failed', 'error', 'abort', 'cancelled', 'request.start', 'attempt.start', 'attempt.end', 'request.end', 'recovery.decision', 'history.projected', 'encrypted_reasoning_downgrade']);
const NUMERIC_FIELDS = ['attempt', 'removed', 'removedEncrypted', 'droppedReasoning', 'removedIds', 'encryptedRetries', 'maxAttempts', 'totalAttempts', 'transientAttempts', 'resourceAttempts', 'transientRetries', 'resourceRetries', 'projectionRetries', 'delayMs', 'localDelayMs', 'retryAfterMs', 'requiredDelayMs', 'remainingMs', 'deadlineMs', 'startedAtMs', 'deadlineAtMs', 'lastNowMs', 'nextAttemptAtMs', 'durationMs', 'baseDelayMs', 'maxDelayMs', 'jitterRatio', 'bytes', 'count'];
const BOOLEAN_FIELDS = ['ok', 'retry', 'automatic', 'projectHistory', 'projectEncryptedReasoning', 'lossy', 'generic400ProjectionCandidate', 'committed', 'hasOutput', 'unknown', 'terminal', 'empty', 'error', 'cancelled', 'aborted'];
const ENUM_FIELDS = { classification: CATEGORIES, category: CATEGORIES, reason: REASONS, code: REASONS, kind: new Set([...CATEGORIES, 'full_history_copy']), mode: new Set(['auto', 'minimal', 'codex', 'harness']), status: new Set(['queued', 'in_progress', 'completed', 'failed', 'incomplete', 'cancelled']) };
const MAX_ITEMS = 10000;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Read data properties only: neither user getters nor toJSON hooks run in logging.
function get(value, key) {
  if (value === null || typeof value !== 'object') return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}

function has(value, key) {
  try { return value !== null && typeof value === 'object' && Object.hasOwn(value, key); } catch { return false; }
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function status(value) {
  if (typeof value === 'string' && /^\d{3}$/.test(value)) value = Number(value);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function fingerprint(value) {
  if (typeof value !== 'string') return undefined;
  return { sha256: crypto.createHash('sha256').update(value).digest('hex'), bytes: Buffer.byteLength(value) };
}

function credentialLike(value) {
  return /^(?:bearer|basic)\b|(?:^|[_.:-])(?:sk|pk|api[_-]?key|token|secret|password)[_-]|[\r\n\s@?=&]/i.test(value);
}

function safeIdentifier(value, model = false) {
  if (typeof value !== 'string' || value.length < 1 || value.length > (model ? 96 : 128) || credentialLike(value)) return false;
  if (model) return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value);
  return /^(?:[a-fA-F0-9]{16,64}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}|(?:req(?:uest)?|trace|attempt|call|corr(?:elation)?)[_.:-][a-zA-Z0-9_.:-]+)$/i.test(value);
}

function identifier(value, model = false) {
  return safeIdentifier(value, model) ? value : fingerprint(value);
}

function enumValue(value, allowed) {
  if (typeof value !== 'string') return undefined;
  if (allowed.has(value)) return value;
  if (allowed === REASONS && /^http_[1-5]\d{2}$/.test(value)) return value;
  return undefined;
}

function summarizeStructured(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return enumValue(value, CATEGORIES);
  if (!record(value)) return {};
  const result = {};
  for (const key of NUMERIC_FIELDS) if (numeric(get(value, key))) result[key] = get(value, key);
  for (const key of BOOLEAN_FIELDS) if (typeof get(value, key) === 'boolean') result[key] = get(value, key);
  for (const [key, allowed] of Object.entries(ENUM_FIELDS)) {
    const selected = enumValue(get(value, key), allowed);
    if (selected !== undefined) result[key] = selected;
  }
  // Recovery's state and policy contain numbers, never request bodies.
  for (const key of ['policy', 'nextState']) {
    if (record(get(value, key))) {
      const child = {};
      for (const field of NUMERIC_FIELDS) if (numeric(get(get(value, key), field))) child[field] = get(get(value, key), field);
      if (key === 'nextState' && record(get(get(value, key), 'policy'))) {
        child.policy = {};
        for (const field of NUMERIC_FIELDS) if (numeric(get(get(get(value, key), 'policy'), field))) child.policy[field] = get(get(get(value, key), 'policy'), field);
      }
      result[key] = child;
    }
  }
  return result;
}

function summarizeHeaders(headers) {
  const result = {};
  for (const name of HEADER_NAMES) {
    let value;
    // Native Headers stores its values internally, not as own data properties.
    try {
      if (typeof Headers !== 'undefined' && headers instanceof Headers) value = Headers.prototype.get.call(headers, name);
      else if (record(headers)) {
        const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name);
        if (key !== undefined) value = get(headers, key);
      }
    } catch { continue; }
    if (Array.isArray(value)) value = get(value, '0');
    if (typeof value !== 'string') continue;
    const traceparent = name === 'traceparent' && /^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/.test(value);
    const amazonTrace = name === 'x-amzn-trace-id' && /^Root=1-[a-f0-9]{8}-[a-f0-9]{24}$/.test(value);
    result[name] = traceparent || amazonTrace ? value : identifier(value);
  }
  return result;
}

function summarizeError(error) {
  if (typeof error === 'string') return { category: 'unknown', message: fingerprint(error) };
  if (!record(error)) return {};
  const result = {};
  const seen = new Set();
  function visit(value, depth) {
    if (!record(value) || seen.has(value) || depth > 3) return;
    seen.add(value);
    for (const key of ['statusCode', 'status_code', 'status']) {
      const code = status(get(value, key));
      if (code !== undefined && result.statusCode === undefined) result.statusCode = code;
    }
    for (const key of ['category', 'classification']) {
      const category = enumValue(get(value, key), CATEGORIES);
      if (category !== undefined && result.category === undefined) result.category = category;
    }
    for (const key of ['code', 'type', 'name']) {
      const text = get(value, key);
      if (typeof text !== 'string') continue;
      const normalized = text.toLowerCase();
      if (ERROR_CODES.has(normalized) && result.code === undefined) result.code = normalized;
      else if (!ERROR_CODES.has(normalized) && result.codeHash === undefined) result.codeHash = fingerprint(text);
    }
    if (typeof get(value, 'message') === 'string' && result.message === undefined) result.message = fingerprint(get(value, 'message'));
    for (const key of ['error', 'cause', 'innererror', 'inner_error']) visit(get(value, key), depth + 1);
  }
  visit(error, 0);
  if (result.category === undefined) result.category = 'unknown';
  return result;
}

function summarizeRequest(body) {
  if (!record(body)) return { invalid: true };
  const result = {
    topLevelKeys: TOP_LEVEL_KEYS.filter(key => has(body, key)),
    roles: {}, itemTypes: {}, inputCount: 0, messageCount: 0, toolCount: 0,
    schemaCount: 0, schemaPropertyCount: 0, strictTrueCount: 0, strictFalseCount: 0,
    resourceItemIdCount: 0, textBytes: 0, imageCount: 0, imageBytes: 0,
    pairingIssues: { duplicateCalls: 0, duplicateOutputs: 0, missingCalls: 0, missingOutputs: 0, invalidIds: 0, typeMismatches: 0 },
    truncated: false
  };
  const model = get(body, 'model');
  if (safeIdentifier(model, true)) result.model = model;
  else if (typeof model === 'string') result.modelHash = fingerprint(model);
  const effort = get(get(body, 'reasoning'), 'effort') ?? get(body, 'reasoning_effort') ?? get(get(body, 'output_config'), 'effort');
  if (EFFORTS.has(effort)) result.effort = effort;
  const calls = new Map();
  const outputs = new Set();
  let visited = 0;
  function array(value, visitor) {
    if (!Array.isArray(value)) return;
    const length = get(value, 'length');
    for (let i = 0; i < length; i++) {
      if (++visited > MAX_ITEMS) { result.truncated = true; break; }
      visitor(get(value, String(i)));
    }
  }
  function count(map, value, allowed) {
    const key = allowed.has(value) ? value : 'unknown';
    map[key] = (map[key] || 0) + 1;
  }
  function call(id, type) {
    if (typeof id !== 'string' || !id.length || id.length > 1024) { result.pairingIssues.invalidIds++; return; }
    if (calls.has(id)) result.pairingIssues.duplicateCalls++;
    else calls.set(id, type);
  }
  function output(id, type) {
    if (typeof id !== 'string' || !id.length || id.length > 1024) { result.pairingIssues.invalidIds++; return; }
    if (!calls.has(id)) result.pairingIssues.missingCalls++;
    else if (calls.get(id) !== type) result.pairingIssues.typeMismatches++;
    if (outputs.has(id)) result.pairingIssues.duplicateOutputs++;
    outputs.add(id);
  }
  function bytes(value) { return typeof value === 'string' ? Buffer.byteLength(value) : 0; }
  function image(part) {
    result.imageCount++;
    const source = get(part, 'source');
    const imageUrl = get(part, 'image_url');
    const data = get(source, 'data');
    if (typeof data === 'string') result.imageBytes += bytes(data);
    else if (typeof imageUrl === 'string') result.imageBytes += bytes(imageUrl);
    else if (record(imageUrl)) result.imageBytes += bytes(get(imageUrl, 'url'));
    else result.imageBytes += bytes(get(source, 'url'));
  }
  function content(part) {
    if (!record(part)) return;
    const type = get(part, 'type');
    count(result.itemTypes, type, ITEM_TYPES);
    if (['text', 'input_text', 'output_text'].includes(type)) result.textBytes += bytes(get(part, 'text'));
    else if (['image', 'input_image', 'image_url'].includes(type)) image(part);
    else if (type === 'tool_use' || type === 'server_tool_use') call(get(part, 'id'), 'messages');
    else if (type === 'tool_result') output(get(part, 'tool_use_id'), 'messages');
    // Tool inputs/results, signatures and encrypted reasoning are never visited.
  }
  const schemaSeen = new Set();
  function schema(value, depth = 0) {
    if (!record(value) || schemaSeen.has(value) || depth > 24 || ++visited > MAX_ITEMS) { if (visited > MAX_ITEMS || depth > 24) result.truncated = true; return; }
    schemaSeen.add(value);
    result.schemaCount++;
    const properties = get(value, 'properties');
    if (record(properties)) {
      let keys;
      try { keys = Object.keys(properties); } catch { keys = []; }
      result.schemaPropertyCount += keys.length;
      for (const key of keys.slice(0, MAX_ITEMS)) {
        if (visited >= MAX_ITEMS) { result.truncated = true; break; }
        schema(get(properties, key), depth + 1);
      }
      if (keys.length > MAX_ITEMS) result.truncated = true;
    }
    for (const key of ['items', 'additionalProperties', 'not']) schema(get(value, key), depth + 1);
    for (const key of ['anyOf', 'allOf', 'oneOf', 'prefixItems']) array(get(value, key), child => schema(child, depth + 1));
  }
  const toolSeen = new Set();
  function tool(value, depth = 0) {
    if (!record(value) || toolSeen.has(value)) return;
    if (depth > 24 || ++visited > MAX_ITEMS) { result.truncated = true; return; }
    toolSeen.add(value);
    result.toolCount++;
    const fn = record(get(value, 'function')) ? get(value, 'function') : value;
    if (get(fn, 'strict') === true) result.strictTrueCount++;
    if (get(fn, 'strict') === false) result.strictFalseCount++;
    schema(get(fn, 'parameters') ?? get(fn, 'input_schema'));
    if (get(value, 'type') === 'namespace') array(get(value, 'tools'), child => tool(child, depth + 1));
  }
  function item(value) {
    if (!record(value)) { count(result.itemTypes, undefined, ITEM_TYPES); return; }
    const type = get(value, 'type');
    if (type !== undefined) count(result.itemTypes, type, ITEM_TYPES);
    if (has(value, 'role')) count(result.roles, get(value, 'role'), ROLES);
    if (has(value, 'id')) result.resourceItemIdCount++;
    if (['function_call', 'custom_tool_call'].includes(type)) call(get(value, 'call_id'), type === 'function_call' ? 'function' : 'custom');
    else if (['function_call_output', 'custom_tool_call_output'].includes(type)) output(get(value, 'call_id'), type === 'function_call_output' ? 'function' : 'custom');
    else if (type === 'additional_tools') array(get(value, 'tools'), tool);
    if (get(value, 'role') === 'tool') output(get(value, 'tool_call_id'), 'chat');
    array(get(value, 'tool_calls'), child => call(get(child, 'id'), 'chat'));
    if (type === undefined || type === 'message') {
      const parts = get(value, 'content');
      if (typeof parts === 'string') result.textBytes += bytes(parts);
      else array(parts, content);
    }
  }
  const input = get(body, 'input');
  const messages = get(body, 'messages');
  if (Array.isArray(input)) { result.inputCount = get(input, 'length'); array(input, item); }
  else if (typeof input === 'string') result.textBytes += bytes(input);
  if (Array.isArray(messages)) { result.messageCount = get(messages, 'length'); array(messages, item); }
  result.textBytes += bytes(get(body, 'instructions')) + bytes(get(body, 'system'));
  array(get(body, 'system'), content);
  array(get(body, 'tools'), tool);
  const format = get(get(body, 'text'), 'format') ?? get(get(body, 'response_format'), 'json_schema');
  if (record(format)) {
    if (get(format, 'strict') === true) result.strictTrueCount++;
    if (get(format, 'strict') === false) result.strictFalseCount++;
    schema(get(format, 'schema'));
  }
  for (const id of calls.keys()) if (!outputs.has(id)) result.pairingIssues.missingOutputs++;
  return result;
}

function summarizeEvent(event) {
  if (!record(event)) return null;
  const result = {};
  if (typeof get(event, 'type') === 'string') result.type = EVENT_TYPES.has(get(event, 'type')) ? get(event, 'type') : 'unknown';
  for (const key of ['requestId', 'attemptId']) {
    if (typeof get(event, key) === 'string') result[key] = identifier(get(event, key));
  }
  for (const key of ['attempt', 'durationMs']) if (numeric(get(event, key))) result[key] = get(event, key);
  if (status(get(event, 'statusCode')) !== undefined) result.statusCode = status(get(event, 'statusCode'));
  if (has(event, 'headers')) result.headers = summarizeHeaders(get(event, 'headers'));
  if (has(event, 'request')) result.request = summarizeRequest(get(event, 'request'));
  if (has(event, 'error')) result.error = summarizeError(get(event, 'error'));
  for (const key of ['classification', 'projection', 'retry', 'budget']) {
    if (has(event, key)) {
      const value = summarizeStructured(get(event, key));
      if (value !== undefined) result[key] = value;
    }
  }
  return result;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function checkedFile(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || process.getuid && stat.uid !== process.getuid()) throw new Error('Unsafe diagnostic file.');
  return stat;
}

function privateFile(file, before) {
  if (process.platform === 'win32' || !before) return;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || process.getuid && opened.uid !== process.getuid()) throw new Error('Diagnostic file changed.');
    fs.fchmodSync(fd, 0o600);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function trustedSystemPath(file) {
  if (process.platform !== 'darwin') return file;
  // macOS owns these two system aliases. Never realpath a user-selected parent.
  for (const [alias, target] of [['/tmp', '/private/tmp'], ['/var', '/private/var']]) {
    if (!file.startsWith(`${alias}/`)) continue;
    const link = fs.lstatSync(alias);
    if (link.isSymbolicLink() && link.uid === 0 && fs.realpathSync(alias) === target) return `${target}${file.slice(alias.length)}`;
  }
  return file;
}

function checkedParents(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch (createError) { if (createError.code !== 'EEXIST') throw createError; }
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe diagnostic parent.');
    if (process.platform !== 'win32') {
      if (process.getuid && stat.uid !== process.getuid() && stat.uid !== 0) throw new Error('Untrusted diagnostic parent.');
      if (stat.mode & 0o022 && !(stat.mode & 0o1000)) throw new Error('Writable diagnostic parent.');
    }
  }
}

function writeLine(file, line, maxFileBytes, maxFiles) {
  const byteLength = Buffer.byteLength(line);
  if (byteLength > maxFileBytes) return;
  file = trustedSystemPath(file);
  checkedParents(path.dirname(file));
  const files = Array.from({ length: maxFiles }, (_, index) => index === 0 ? file : `${file}.${index}`);
  const stats = files.map(checkedFile);
  for (let i = 0; i < files.length; i++) privateFile(files[i], stats[i]);
  if (stats[0] && stats[0].size + byteLength > maxFileBytes) {
    if (maxFiles === 1) fs.unlinkSync(file);
    else {
      if (stats[maxFiles - 1]) fs.unlinkSync(files[maxFiles - 1]);
      for (let i = maxFiles - 2; i >= 0; i--) if (stats[i]) fs.renameSync(files[i], files[i + 1]);
    }
  }
  const before = checkedFile(file);
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0) | (before ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
  let fd;
  let initialSize;
  let opened;
  try {
    fd = fs.openSync(file, flags, 0o600);
    opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || before && (opened.ino !== before.ino || opened.dev !== before.dev)) throw new Error('Diagnostic file changed.');
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    if (opened.size + byteLength > maxFileBytes) return;
    initialSize = opened.size;
    const buffer = Buffer.from(line);
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
      if (written <= 0) throw new Error('Diagnostic write made no progress.');
      offset += written;
    }
  } catch (error) {
    if (fd !== undefined && initialSize !== undefined) {
      try { fs.ftruncateSync(fd, initialSize); } catch {
        // Windows append handles may not permit truncation. Reopen without append
        // only after checking that the file is still the inode we wrote to.
        let rollbackFd;
        try {
          rollbackFd = fs.openSync(file, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0));
          const current = fs.fstatSync(rollbackFd);
          if (!current.isFile() || current.nlink !== 1 || current.ino !== opened.ino || current.dev !== opened.dev
            || process.getuid && current.uid !== process.getuid()) throw new Error('Diagnostic file changed.');
          fs.ftruncateSync(rollbackFd, initialSize);
        } catch { /* A failed disk may also reject rollback. */ }
        finally { if (rollbackFd !== undefined) fs.closeSync(rollbackFd); }
      }
    }
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function createDiagnostics(options = {}) {
  if (get(options, 'enabled') !== true) return { enabled: false, emit() {}, close() {} };
  const onEvent = get(options, 'onEvent');
  const configuredPath = get(options, 'filePath');
  if (configuredPath !== undefined && (typeof configuredPath !== 'string' || !configuredPath.trim().length || configuredPath.includes('\0'))) throw new TypeError('Invalid diagnostic filePath.');
  const file = configuredPath === undefined ? null : path.resolve(configuredPath);
  const configuredBytes = get(options, 'maxFileBytes');
  const configuredFiles = get(options, 'maxFiles');
  if (configuredBytes !== undefined && (!Number.isSafeInteger(configuredBytes) || configuredBytes < 1 || configuredBytes > 16 * 1024 * 1024)) throw new TypeError('Invalid diagnostic maxFileBytes.');
  if (configuredFiles !== undefined && (!Number.isSafeInteger(configuredFiles) || configuredFiles < 1 || configuredFiles > 10)) throw new TypeError('Invalid diagnostic maxFiles.');
  const maxFileBytes = configuredBytes === undefined ? 1048576 : configuredBytes;
  const maxFiles = configuredFiles === undefined ? 3 : configuredFiles;
  let closed = false;
  return {
    enabled: true,
    emit(event) {
      if (closed) return;
      let safe;
      try {
        const value = typeof event === 'function' ? event() : event;
        if (value instanceof Promise) { value.catch(() => {}); return; }
        safe = summarizeEvent(value);
        if (!safe) return;
        freeze(safe);
      } catch { return; }
      if (file) {
        try { writeLine(file, `${JSON.stringify(safe)}\n`, maxFileBytes, maxFiles); } catch { /* Diagnostics never fail a request. */ }
      }
      if (typeof onEvent === 'function') {
        try { Promise.resolve(onEvent(safe)).catch(() => {}); } catch { /* A diagnostic consumer is not the relay. */ }
      }
      return safe;
    },
    close() { closed = true; }
  };
}

module.exports = { createDiagnostics, summarizeRequest, summarizeError, summarizeHeaders };
