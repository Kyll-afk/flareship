const DEFAULT_BASE = 'https://api.cloudflare.com/client/v4';

export class ApiError extends Error {
  constructor(message, { status = 0, codes = [] } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.codes = codes;
  }

  has(code) {
    return this.codes.includes(code);
  }
}

const AUTH_CODES = [10000, 10001, 9106, 9109];
const GIT_ACCESS_CODES = [8000011, 8000012];
const NO_BUILD_CONFIG = 12040;

export function isAuthError(error) {
  if (!(error instanceof ApiError) || GIT_ACCESS_CODES.some((code) => error.has(code))) return false;
  return error.status === 401 || error.status === 403 || AUTH_CODES.some((code) => error.has(code));
}

export function createClient({ token, base, refresh, fetchImpl = globalThis.fetch }) {
  const root = (base || DEFAULT_BASE).replace(/\/+$/, '');
  let current = token;
  let refreshed = false;

  async function request(method, path, options) {
    try {
      return await send(method, path, options);
    } catch (error) {
      if (!refresh || refreshed || !isAuthError(error)) throw error;
      refreshed = true;
      const next = await refresh();
      if (!next || next === current) throw error;
      current = next;
      return send(method, path, options);
    }
  }

  async function send(method, path, { query, body, form } = {}) {
    const url = new URL(root + path);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = { Authorization: `Bearer ${current}` };
    let payload;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(url, { method, headers, body: payload });
    } catch (error) {
      throw new ApiError(`Could not reach Cloudflare: ${error.cause?.message || error.message}`);
    }

    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (!response.ok || !json || json.success === false) {
      const errors = json?.errors || [];
      const message = errors.map((e) => e.message).filter(Boolean).join('; ') || `Cloudflare answered HTTP ${response.status}`;
      throw new ApiError(message, { status: response.status, codes: errors.map((e) => e.code) });
    }
    return json;
  }

  const project = (accountId, name) => `/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}`;

  return {
    request,

    async verifyToken() {
      return (await request('GET', '/user/tokens/verify')).result;
    },

    async listAccounts() {
      return (await request('GET', '/accounts')).result || [];
    },

    async listProjects(accountId) {
      const all = [];
      for (let page = 1; page <= 50; page++) {
        const reply = await request('GET', `/accounts/${accountId}/pages/projects`, { query: { page } });
        const batch = reply.result || [];
        all.push(...batch);
        const pages = reply.result_info?.total_pages;
        if (!pages || page >= pages || batch.length === 0) break;
      }
      return all;
    },

    async getProject(accountId, name) {
      return (await request('GET', project(accountId, name))).result;
    },

    async createProject(accountId, body) {
      return (await request('POST', `/accounts/${accountId}/pages/projects`, { body })).result;
    },

    async createDeployment(accountId, name, branch) {
      const form = new FormData();
      if (branch) form.set('branch', branch);
      return (await request('POST', `${project(accountId, name)}/deployments`, { form })).result;
    },

    async listDeployments(accountId, name, perPage = 10) {
      const reply = await request('GET', `${project(accountId, name)}/deployments`, { query: { per_page: perPage } });
      return reply.result || [];
    },

    async getDeployment(accountId, name, id) {
      return (await request('GET', `${project(accountId, name)}/deployments/${id}`)).result;
    },

    async deploymentLogs(accountId, name, id) {
      const reply = await request('GET', `${project(accountId, name)}/deployments/${id}/history/logs`);
      return reply.result?.data || [];
    },

    async listScripts(accountId) {
      return (await request('GET', `/accounts/${accountId}/workers/scripts`)).result || [];
    },

    async workersSubdomain(accountId) {
      return (await request('GET', `/accounts/${accountId}/workers/subdomain`)).result?.subdomain || null;
    },

    async createPlaceholderWorker(accountId, name) {
      const code = "export default { fetch() { return new Response('The first build is still running.', { status: 503 }); } };\n";
      const form = new FormData();
      form.set('metadata', JSON.stringify({ main_module: 'index.js', compatibility_date: '2025-01-01' }));
      form.set('index.js', new Blob([code], { type: 'application/javascript+module' }), 'index.js');
      return (await request('PUT', `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}`, { form })).result;
    },

    async listBuildTokens(accountId) {
      return (await request('GET', `/accounts/${accountId}/builds/tokens`)).result || [];
    },

    async getWorkerBuildConfig(accountId, tag) {
      try {
        return (await request('GET', `/accounts/${accountId}/builds/workers/${tag}`)).result;
      } catch (error) {
        if (error instanceof ApiError && (error.has(NO_BUILD_CONFIG) || error.status === 404)) return null;
        throw error;
      }
    },

    async createWorkerBuildConfig(accountId, body) {
      return (await request('POST', `/accounts/${accountId}/builds/workers`, { body })).result;
    },

    async listTriggers(accountId, tag) {
      return (await request('GET', `/accounts/${accountId}/builds/workers/${tag}/triggers`)).result || [];
    },

    async startBuild(accountId, triggerId, branch) {
      return (await request('POST', `/accounts/${accountId}/builds/triggers/${triggerId}/builds`, { body: { branch } })).result;
    },

    async listWorkerBuilds(accountId, tag, perPage = 10) {
      const reply = await request('GET', `/accounts/${accountId}/builds/workers/${tag}/builds`, { query: { per_page: perPage } });
      return Array.isArray(reply.result) ? reply.result : reply.result?.builds || [];
    },

    async getBuild(accountId, id) {
      return (await request('GET', `/accounts/${accountId}/builds/builds/${id}`)).result;
    },

    async buildLogs(accountId, id) {
      const lines = [];
      let cursor;
      for (let page = 0; page < 50; page++) {
        const result = (await request('GET', `/accounts/${accountId}/builds/builds/${id}/logs`, { query: { cursor } })).result || {};
        for (const entry of result.lines || []) lines.push({ line: Array.isArray(entry) ? String(entry[1] ?? '') : String(entry) });
        if (!result.truncated || !result.cursor || result.cursor === cursor) break;
        cursor = result.cursor;
      }
      return lines;
    },
  };
}
